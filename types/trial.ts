export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction =
  | 'randomized'
  | 'unblinded'
  | 'unblind-withdrawn'
  | 'unblind-verified'
  | 'unblind-rejected'
  | 'pending-queued'
  | 'pending-committed'
  | 'duplicate-blocked';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: 'randomized' | 'unblinded';
  sequence: number;
  arm?: Arm;
  unblindedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: AuditAction;
  detail: string;
  participantNo?: string;
}

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed';
}

/**
 * 揭盲记录（仅追加）。
 * 撤回或核查不成立时不删除记录，而是把 status 置为 withdrawn 恢复盲态，
 * 并追加审计条目留下过程。
 */
export interface UnblindingRecord {
  /** 申请编号，作为写盘重试与幂等的唯一键 */
  id: string;
  participantId: string;
  participantNo: string;
  /** 披露的治疗组（仅该受试者本人） */
  arm: Arm;
  reason: string;
  applicant: string;
  appliedAt: string;
  status: 'active' | 'withdrawn';
  verification: 'pending' | 'confirmed' | 'rejected';
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawReason?: string;
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}

export interface UnblindInput {
  participantId: string;
  reason: string;
  actor: string;
  /** 申请编号；写盘失败后按此重试，不重复记账 */
  applicationNo?: string;
}

export interface UnblindResult {
  ok: boolean;
  message: string;
  arm?: Arm;
  applicationNo?: string;
}
