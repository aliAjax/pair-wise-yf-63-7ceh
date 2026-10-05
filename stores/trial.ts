import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput, UnblindingRecord, UnblindInput, UnblindResult } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v2';

interface PersistSnapshot {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  unblindings: UnblindingRecord[];
}

const seed: PersistSnapshot = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002', participantNo: 'S01-002' }
  ],
  pending: [],
  unblindings: []
};

/** 写盘重试队列（非持久化）：按申请编号缓存待写快照，重试时不重复记账 */
const pendingWrites = new Map<string, PersistSnapshot>();

/**
 * 区组同伴：同一分层（中心+年龄）内按随机号排序后，两人区组中与该受试者同组的另一人。
 * 用于受控披露——隐藏同区组其他人的治疗组与发药编号。
 */
export function blockMatesOf(participant: Participant, all: Participant[]): Participant[] {
  const stratum = all
    .filter((item) => item.site === participant.site && item.ageBand === participant.ageBand)
    .sort((a, b) => a.sequence - b.sequence);
  const idx = stratum.findIndex((item) => item.id === participant.id);
  if (idx < 0) return [];
  const mateIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
  if (mateIdx < 0 || mateIdx >= stratum.length) return [];
  return [stratum[mateIdx]];
}

export const useTrialStore = defineStore('trial', {
  state: () => ({
    ...readLocal<PersistSnapshot>(STORAGE_KEY, seed),
    /** 模拟下次写盘失败（演示用，非持久化） */
    persistFailureArmed: false,
    /** 待重试写盘的申请编号（非持久化） */
    pendingWriteNos: [] as string[]
  }),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    activeUnblindings: (state) => state.unblindings.filter((item) => item.status === 'active'),
    hasPendingWrites: (state) => state.pendingWriteNos.length > 0
  },
  actions: {
    snapshot(): PersistSnapshot {
      return { participants: this.participants, audits: this.audits, pending: this.pending, unblindings: this.unblindings };
    },
    persist() {
      writeLocal(STORAGE_KEY, this.snapshot());
    },
    /**
     * 写盘失败后按申请编号重试。
     * 重试只重写快照，不追加审计条目——不重复记账。
     */
    persistWithRetry(applicationNo?: string): boolean {
      const snapshot = this.snapshot();
      // 模拟一次持续性写盘失败（演示用）：本次写盘的所有尝试都失败，进入队列后手动重试
      const persistentFailure = this.persistFailureArmed;
      if (persistentFailure) this.persistFailureArmed = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (persistentFailure) throw new Error('模拟写盘失败');
          writeLocal(STORAGE_KEY, snapshot);
          if (applicationNo) {
            pendingWrites.delete(applicationNo);
            this.pendingWriteNos = this.pendingWriteNos.filter((no) => no !== applicationNo);
          }
          return true;
        } catch {
          if (attempt === 3 && applicationNo) {
            pendingWrites.set(applicationNo, snapshot);
            if (!this.pendingWriteNos.includes(applicationNo)) this.pendingWriteNos.push(applicationNo);
          }
        }
      }
      return false;
    },
    retryWrite(applicationNo: string) {
      const snapshot = pendingWrites.get(applicationNo);
      if (!snapshot) return;
      try {
        writeLocal(STORAGE_KEY, snapshot);
        pendingWrites.delete(applicationNo);
        this.pendingWriteNos = this.pendingWriteNos.filter((no) => no !== applicationNo);
      } catch {
        // 仍失败则保留在队列中，等待下次重试
      }
    },
    retryAllWrites() {
      for (const no of [...this.pendingWriteNos]) this.retryWrite(no);
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo });
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        this.persist();
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        this.persist();
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm: Arm } {
      const sequence = 1000 + this.participants.length + 1;
      const sameStratum = this.participants.filter((item) => item.site === input.site && item.ageBand === input.ageBand);
      const arm: Arm = sameStratum.filter((item) => item.arm === 'A').length <= sameStratum.filter((item) => item.arm === 'B').length ? 'A' : 'B';
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，序列号 ${sequence}`, input.actor, input.participantNo);
      this.persist();
      return { ok: true, message: `随机成功，中央序列号 ${sequence}`, arm };
    },
    commitPending(id: string, actor: string) {
      const pending = this.pending.find((item) => item.id === id && item.status === 'pending');
      if (!pending) return;
      pending.status = 'committed';
      this.commitRandomization(pending.payload);
      this.addAudit('pending-committed', `待提交记录已确认入库：${pending.payload.participantNo}`, actor, pending.payload.participantNo);
      this.persist();
    },
    /**
     * 受控披露揭盲。
     * - 幂等：同一申请编号重试不重复记账，直接返回既有结果。
     * - 并发控制：同一受试者只允许一方揭盲成功，其余被阻止。
     * - 只披露该受试者本人的治疗组；同区组其他人的治疗组与发药编号继续隐藏。
     */
    requestUnblinding(input: UnblindInput): UnblindResult {
      const applicationNo = input.applicationNo ?? crypto.randomUUID();
      const actor = input.actor.trim();
      const reason = input.reason.trim();

      // 幂等重试：申请编号已存在则直接返回，不重复追加审计
      const existing = this.unblindings.find((item) => item.id === applicationNo);
      if (existing) {
        this.persistWithRetry(applicationNo);
        return { ok: true, message: '揭盲申请已存在，按申请编号幂等返回', arm: existing.arm, applicationNo };
      }

      // 并发控制：同一受试者已有生效中的揭盲记录时，只让一方成功
      const activeOther = this.unblindings.find((item) => item.participantId === input.participantId && item.status === 'active');
      if (activeOther) {
        return { ok: false, message: '该受试者已有生效中的揭盲记录，重复揭盲已阻止', applicationNo };
      }

      const participant = this.participants.find((item) => item.id === input.participantId);
      if (!participant) return { ok: false, message: '未找到受试者', applicationNo };
      if (!reason) return { ok: false, message: '揭盲原因不能为空', applicationNo };
      if (!actor) return { ok: false, message: '操作人不能为空', applicationNo };

      const record: UnblindingRecord = {
        id: applicationNo,
        participantId: participant.id,
        participantNo: participant.participantNo,
        arm: participant.arm!,
        reason,
        applicant: actor,
        appliedAt: new Date().toISOString(),
        status: 'active',
        verification: 'pending'
      };
      this.unblindings.unshift(record);
      participant.status = 'unblinded';
      participant.unblindedAt = record.appliedAt;
      // 审计条目仅记录该受试者的受控披露，不涉及区组其他人
      this.addAudit('unblinded', `紧急揭盲（受控披露）：${participant.participantNo}；原因：${reason}；仅披露该受试者治疗组`, actor, participant.participantNo);

      const writeOk = this.persistWithRetry(applicationNo);
      return {
        ok: true,
        message: writeOk ? `${participant.participantNo} 已揭盲，审计记录已追加` : `${participant.participantNo} 已揭盲，写盘失败已按申请编号排队重试`,
        arm: record.arm,
        applicationNo
      };
    },
    /**
     * 撤回揭盲：恢复盲态，记录仅追加（不删除），并留下过程。
     */
    withdrawUnblinding(recordId: string, actor: string, reason: string): UnblindResult {
      const record = this.unblindings.find((item) => item.id === recordId);
      if (!record || record.status !== 'active') return { ok: false, message: '无生效中的揭盲记录' };
      if (!reason.trim()) return { ok: false, message: '撤回原因不能为空' };
      record.status = 'withdrawn';
      record.withdrawnAt = new Date().toISOString();
      record.withdrawnBy = actor.trim();
      record.withdrawReason = reason.trim();
      this.restoreBlinding(record.participantId);
      this.addAudit('unblind-withdrawn', `揭盲已撤回，恢复盲态：${record.participantNo}；原因：${record.withdrawReason}`, actor, record.participantNo);
      this.persist();
      return { ok: true, message: '揭盲已撤回，盲态已恢复' };
    },
    /**
     * 核查：确认成立则维持揭盲；核查不成立则恢复盲态并留下过程。
     */
    verifyUnblinding(recordId: string, approved: boolean, actor: string, note?: string): UnblindResult {
      const record = this.unblindings.find((item) => item.id === recordId);
      if (!record) return { ok: false, message: '未找到揭盲记录' };
      if (record.verification !== 'pending') return { ok: false, message: '该揭盲记录已核查' };
      if (approved) {
        record.verification = 'confirmed';
        this.addAudit('unblind-verified', `揭盲核查确认成立：${record.participantNo}，治疗组 ${record.arm}`, actor, record.participantNo);
        this.persist();
        return { ok: true, message: '核查确认，揭盲有效' };
      }
      record.verification = 'rejected';
      record.status = 'withdrawn';
      record.withdrawnAt = new Date().toISOString();
      record.withdrawnBy = actor.trim();
      record.withdrawReason = note?.trim() || '核查不成立';
      this.restoreBlinding(record.participantId);
      this.addAudit('unblind-rejected', `揭盲核查不成立，恢复盲态：${record.participantNo}；${record.withdrawReason}`, actor, record.participantNo);
      this.persist();
      return { ok: true, message: '核查不成立，已恢复盲态' };
    },
    restoreBlinding(participantId: string) {
      const participant = this.participants.find((item) => item.id === participantId);
      if (!participant) return;
      participant.status = 'randomized';
      participant.unblindedAt = undefined;
    }
  }
});
