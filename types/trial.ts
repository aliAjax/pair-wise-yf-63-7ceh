export type TrialRole = 'investigator' | 'pharmacist' | 'monitor';
export type Arm = 'A' | 'B';
export type AuditAction = 'randomized' | 'unblinded' | 'blind-restored' | 'pending-queued' | 'pending-committed' | 'duplicate-blocked';

export interface Participant {
  id: string;
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: '18-44' | '45-64' | '65+';
  status: 'randomized' | 'unblinded';
  sequence: number;
  blockId: string;
  kitNo: string;
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

/**
 * 揭盲账本事件：只追加，不修改不删除。
 * - disclose：受控披露某位受试者的治疗组
 * - restore：撤回或核查不成立后恢复盲态，通过 reversesRequestId 指向被逆转的申请
 * requestId 是申请编号，也是幂等键：写盘失败后按原编号重试不会重复记账。
 */
export interface UnblindingEvent {
  id: string;
  requestId: string;
  participantId: string;
  participantNo: string;
  kind: 'disclose' | 'restore';
  reason: string;
  actor: string;
  at: string;
  reversesRequestId?: string;
}

export interface PendingRandomization {
  id: string;
  payload: RandomizeInput;
  createdAt: string;
  status: 'pending' | 'committed';
}

export interface RandomizeInput {
  participantNo: string;
  identityKey: string;
  site: string;
  ageBand: Participant['ageBand'];
  actor: string;
}
