import { defineStore } from 'pinia';
import type { Arm, AuditEntry, Participant, PendingRandomization, RandomizeInput, UnblindingEvent } from '~/types/trial';
import { readLocal, writeLocal } from '~/composables/useLocalPersist';

const STORAGE_KEY = 'trial-randomization-v2';

interface TrialSnapshot {
  participants: Participant[];
  audits: AuditEntry[];
  pending: PendingRandomization[];
  unblindings: UnblindingEvent[];
}

const seed: TrialSnapshot = {
  participants: [
    { id: 'p-1', participantNo: 'S01-001', identityKey: 'demo-a', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1001, blockId: '上海中心|45-64|B1', kitNo: 'KIT-1001', arm: 'A' },
    { id: 'p-2', participantNo: 'S01-002', identityKey: 'demo-b', site: '上海中心', ageBand: '45-64', status: 'randomized', sequence: 1002, blockId: '上海中心|45-64|B1', kitNo: 'KIT-1002', arm: 'B' }
  ],
  audits: [
    { id: 'a-1', at: new Date(Date.now() - 3600_000).toISOString(), actor: '系统', action: 'randomized', detail: 'S01-002 完成分层随机，中央随机号 1002，区组 B1', participantNo: 'S01-002' }
  ],
  pending: [],
  unblindings: []
};

export interface UnblindRequest {
  requestId: string;
  participantId: string;
  reason: string;
  actor: string;
}

export interface UnblindResult {
  ok: boolean;
  message: string;
  /** 写盘失败时为 true：状态已回滚，可按原申请编号安全重试 */
  retryable?: boolean;
  /** 同一申请编号已被受理过，本次为幂等重放，未重复记账 */
  replayed?: boolean;
}

export const useTrialStore = defineStore('trial', {
  state: () => ({ debugFailPersist: false, ...readLocal<TrialSnapshot>(STORAGE_KEY, seed) }),
  getters: {
    bySite: (state) => state.participants.reduce<Record<string, number>>((result, participant) => {
      result[participant.site] = (result[participant.site] ?? 0) + 1;
      return result;
    }, {}),
    pendingCount: (state) => state.pending.filter((item) => item.status === 'pending').length,
    /** 生效中的揭盲：账本按时间倒序（unshift），每位受试者取首条事件，disclose 即为生效中 */
    activeUnblindings: (state) => {
      const latest = new Map<string, UnblindingEvent>();
      for (const event of state.unblindings) {
        if (!latest.has(event.participantId)) latest.set(event.participantId, event);
      }
      const active = new Map<string, UnblindingEvent>();
      for (const [participantId, event] of latest) {
        if (event.kind === 'disclose') active.set(participantId, event);
      }
      return active;
    }
  },
  actions: {
    persist(): boolean {
      if (this.debugFailPersist) return false;
      return writeLocal(STORAGE_KEY, { participants: this.participants, audits: this.audits, pending: this.pending, unblindings: this.unblindings });
    },
    /** 另一操作人可能在别的标签页写入了新状态：先以持久化快照为准再判断，避免双方同时成功 */
    syncFromStorage() {
      if (!import.meta.client) return;
      const fresh = readLocal<TrialSnapshot | null>(STORAGE_KEY, null);
      if (!fresh) return;
      const current = { participants: this.participants, audits: this.audits, pending: this.pending, unblindings: this.unblindings };
      if (JSON.stringify(fresh) !== JSON.stringify(current)) this.$patch(fresh);
    },
    pushAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string): AuditEntry {
      const entry: AuditEntry = { id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, detail, participantNo };
      this.audits.unshift(entry);
      return entry;
    },
    addAudit(action: AuditEntry['action'], detail: string, actor: string, participantNo?: string) {
      this.pushAudit(action, detail, actor, participantNo);
      this.persist();
    },
    randomize(input: RandomizeInput, offline = false): { ok: boolean; message: string; arm?: Arm } {
      if (this.participants.some((item) => item.identityKey === input.identityKey || item.participantNo === input.participantNo)) {
        this.addAudit('duplicate-blocked', `拒绝重复入组：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: false, message: '身份标识或受试者编号已存在，已阻止重复入组' };
      }
      if (offline) {
        const queued: PendingRandomization = { id: crypto.randomUUID(), payload: input, createdAt: new Date().toISOString(), status: 'pending' };
        this.pending.unshift(queued);
        this.addAudit('pending-queued', `离线提交进入待处理队列：${input.participantNo}`, input.actor, input.participantNo);
        return { ok: true, message: '已加入待提交队列，联网后确认入库' };
      }
      return this.commitRandomization(input);
    },
    commitRandomization(input: RandomizeInput): { ok: boolean; message: string; arm: Arm } {
      const sequence = 1000 + this.participants.length + 1;
      const sameStratum = this.participants.filter((item) => item.site === input.site && item.ageBand === input.ageBand);
      const arm: Arm = sameStratum.filter((item) => item.arm === 'A').length <= sameStratum.filter((item) => item.arm === 'B').length ? 'A' : 'B';
      const blockId = `${input.site}|${input.ageBand}|B${Math.floor(sameStratum.length / 2) + 1}`;
      const kitNo = `KIT-${sequence}`;
      const participant: Participant = { id: crypto.randomUUID(), ...input, status: 'randomized', sequence, blockId, kitNo, arm };
      this.participants.unshift(participant);
      this.addAudit('randomized', `${input.participantNo} 完成分层随机，序列号 ${sequence}，区组 ${blockId.split('|').pop()}，发药编号 ${kitNo}`, input.actor, input.participantNo);
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
     * 紧急揭盲（受控披露）：只披露该受试者的治疗组，同区组其他人的组别与发药编号继续隐藏。
     * - 并发守卫：同一受试者只允许一个生效中的揭盲，后到的申请被阻止；
     * - 幂等：requestId 为申请编号，写盘失败后按原编号重试不会重复记账。
     * 审计与账本均不记录组别明文。
     */
    requestUnblind(input: UnblindRequest): UnblindResult {
      const reason = input.reason.trim();
      if (!reason) return { ok: false, message: '揭盲原因不能为空' };
      this.syncFromStorage();
      const existing = this.unblindings.find((event) => event.requestId === input.requestId);
      if (existing) return { ok: true, message: `申请 ${input.requestId} 已受理，未重复记账`, replayed: true };
      const participant = this.participants.find((item) => item.id === input.participantId);
      if (!participant) return { ok: false, message: '受试者不存在' };
      const active = this.activeUnblindings.get(participant.id);
      if (active) {
        this.addAudit('duplicate-blocked', `揭盲申请 ${input.requestId} 被阻止：${participant.participantNo} 已由申请 ${active.requestId} 揭盲`, input.actor, participant.participantNo);
        return { ok: false, message: `该受试者已被申请 ${active.requestId} 揭盲，本次申请未记账` };
      }
      const event: UnblindingEvent = {
        id: crypto.randomUUID(),
        requestId: input.requestId,
        participantId: participant.id,
        participantNo: participant.participantNo,
        kind: 'disclose',
        reason,
        actor: input.actor,
        at: new Date().toISOString()
      };
      const audit = this.pushAudit('unblinded', `紧急揭盲（受控披露）申请 ${input.requestId}：${reason}`, input.actor, participant.participantNo);
      this.unblindings.unshift(event);
      participant.status = 'unblinded';
      participant.unblindedAt = event.at;
      if (!this.persist()) {
        this.unblindings = this.unblindings.filter((item) => item.id !== event.id);
        this.audits = this.audits.filter((item) => item.id !== audit.id);
        participant.status = 'randomized';
        delete participant.unblindedAt;
        return { ok: false, retryable: true, message: '写入失败，未记账；请按原申请编号重试' };
      }
      return { ok: true, message: `已受控披露 ${participant.participantNo} 的治疗组（申请 ${input.requestId}），同区组其他受试者的组别与发药编号继续隐藏` };
    },
    /** 撤回或核查不成立后恢复盲态：只追加 restore 事件，原披露记录保留留痕 */
    restoreBlind(input: { participantId: string; reason: string; actor: string }): UnblindResult {
      const reason = input.reason.trim();
      if (!reason) return { ok: false, message: '恢复盲态原因不能为空' };
      this.syncFromStorage();
      const participant = this.participants.find((item) => item.id === input.participantId);
      if (!participant) return { ok: false, message: '受试者不存在' };
      const active = this.activeUnblindings.get(participant.id);
      if (!active) {
        const restored = this.unblindings.find((event) => event.participantId === participant.id && event.kind === 'restore');
        if (restored) return { ok: true, message: `申请 ${restored.reversesRequestId} 的恢复已记账，未重复`, replayed: true };
        return { ok: false, message: '该受试者当前没有生效中的揭盲' };
      }
      const event: UnblindingEvent = {
        id: crypto.randomUUID(),
        requestId: `${active.requestId}-REV`,
        participantId: participant.id,
        participantNo: participant.participantNo,
        kind: 'restore',
        reason,
        actor: input.actor,
        at: new Date().toISOString(),
        reversesRequestId: active.requestId
      };
      const audit = this.pushAudit('blind-restored', `恢复盲态：申请 ${active.requestId} 被逆转（${reason}），治疗组重新隐藏`, input.actor, participant.participantNo);
      this.unblindings.unshift(event);
      participant.status = 'randomized';
      delete participant.unblindedAt;
      if (!this.persist()) {
        this.unblindings = this.unblindings.filter((item) => item.id !== event.id);
        this.audits = this.audits.filter((item) => item.id !== audit.id);
        participant.status = 'unblinded';
        participant.unblindedAt = active.at;
        return { ok: false, retryable: true, message: '写入失败，未记账；请重试' };
      }
      return { ok: true, message: `已恢复 ${participant.participantNo} 的盲态，过程已留痕` };
    }
  }
});
