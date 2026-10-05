import { strict as assert } from 'node:assert';
import { createPinia, setActivePinia } from 'pinia';
import { useTrialStore } from '~/stores/trial';

setActivePinia(createPinia());
const trial = useTrialStore();

// 1. 受控披露：揭盲成功，账本与审计追加，且均不含组别明文
const r1 = trial.requestUnblind({ requestId: 'UB-TEST-1', participantId: 'p-1', reason: 'SAE 需明确治疗', actor: '研究者A' });
assert.equal(r1.ok, true);
assert.equal(trial.participants.find((p) => p.id === 'p-1')!.status, 'unblinded');
assert.equal(trial.unblindings.length, 1);
assert.equal(trial.unblindings[0]!.kind, 'disclose');
const unblindAudit = trial.audits.find((a) => a.action === 'unblinded')!;
assert.ok(!unblindAudit.detail.includes('组别'), '审计详情不得包含组别明文');
assert.ok(!JSON.stringify(trial.unblindings).includes('"arm"'), '揭盲账本不得记录组别');

// 2. 并发守卫：另一操作人提交同一受试者，只有先到的成功
const r2 = trial.requestUnblind({ requestId: 'UB-TEST-2', participantId: 'p-1', reason: '另一操作人同时提交', actor: '研究者B' });
assert.equal(r2.ok, false);
assert.equal(trial.unblindings.length, 1, '被阻止的申请不得记账');
assert.ok(trial.audits.some((a) => a.action === 'duplicate-blocked'));

// 3. 幂等重放：同一申请编号重试，返回已受理且不重复记账
const r3 = trial.requestUnblind({ requestId: 'UB-TEST-1', participantId: 'p-1', reason: 'SAE 需明确治疗', actor: '研究者A' });
assert.equal(r3.ok, true);
assert.equal(r3.replayed, true);
assert.equal(trial.unblindings.length, 1);

// 4. 写盘失败：整体回滚；按原申请编号重试成功且只记一次
trial.debugFailPersist = true;
const r4 = trial.requestUnblind({ requestId: 'UB-TEST-3', participantId: 'p-2', reason: '过敏反应', actor: '研究者A' });
assert.equal(r4.ok, false);
assert.equal(r4.retryable, true);
assert.equal(trial.participants.find((p) => p.id === 'p-2')!.status, 'randomized', '写盘失败后盲态必须回滚');
assert.equal(trial.unblindings.length, 1, '写盘失败不得留下账本记录');
assert.ok(!trial.audits.some((a) => a.detail.includes('UB-TEST-3')), '写盘失败不得留下审计记录');
trial.debugFailPersist = false;
const r5 = trial.requestUnblind({ requestId: 'UB-TEST-3', participantId: 'p-2', reason: '过敏反应', actor: '研究者A' });
assert.equal(r5.ok, true);
assert.equal(trial.unblindings.filter((e) => e.requestId === 'UB-TEST-3').length, 1, '按原申请编号重试不得重复记账');

// 5. 恢复盲态：只追加 restore 事件，盲态恢复，原披露记录保留留痕
const r6 = trial.restoreBlind({ participantId: 'p-1', reason: '核查不成立', actor: '监察员C' });
assert.equal(r6.ok, true);
assert.equal(trial.participants.find((p) => p.id === 'p-1')!.status, 'randomized');
assert.equal(trial.unblindings.length, 3);
assert.equal(trial.unblindings[0]!.kind, 'restore');
assert.equal(trial.unblindings[0]!.reversesRequestId, 'UB-TEST-1');
assert.ok(trial.unblindings.some((e) => e.requestId === 'UB-TEST-1' && e.kind === 'disclose'), '原披露记录必须保留');
assert.ok(trial.audits.some((a) => a.action === 'blind-restored'));

// 6. 恢复操作幂等：重复恢复不重复记账
const r7 = trial.restoreBlind({ participantId: 'p-1', reason: '重复恢复', actor: '监察员C' });
assert.equal(r7.ok, true);
assert.equal(r7.replayed, true);
assert.equal(trial.unblindings.length, 3);

// 7. 恢复后可重新揭盲
const r8 = trial.requestUnblind({ requestId: 'UB-TEST-4', participantId: 'p-1', reason: '再次 SAE', actor: '研究者A' });
assert.equal(r8.ok, true);
assert.equal(trial.activeUnblindings.get('p-1')!.requestId, 'UB-TEST-4');

// 8. 区组分配：同层第三人进入下一个两人区组
const rz = trial.randomize({ participantNo: 'S01-003', identityKey: 'demo-c', site: '上海中心', ageBand: '45-64', actor: '研究者A' });
assert.equal(rz.ok, true);
const p3 = trial.participants.find((p) => p.participantNo === 'S01-003')!;
assert.equal(p3.blockId, '上海中心|45-64|B2');
assert.equal(p3.arm, 'A');
assert.equal(p3.kitNo, `KIT-${p3.sequence}`);

console.log('store tests passed: 受控披露 / 并发守卫 / 幂等重试 / 写盘回滚 / 恢复盲态 / 区组分配');
