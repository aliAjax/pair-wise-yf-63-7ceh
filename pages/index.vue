<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore, blockMatesOf } from '~/stores/trial';
import type { Arm, AuditAction, Participant, TrialRole, UnblindingRecord } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, unblindings, activeUnblindings, pendingWriteNos, hasPendingWrites, persistFailureArmed } = storeToRefs(trial);
const role = ref<TrialRole>('investigator');
const offline = ref(false);
const schema = toTypedSchema(z.object({
  participantNo: z.string().min(4, '请输入至少4位受试者编号'),
  identityKey: z.string().min(4, '请输入身份核验标识'),
  site: z.string().min(2, '请选择研究中心'),
  ageBand: z.enum(['18-44', '45-64', '65+']),
  actor: z.string().min(2, '请输入操作人')
}));
const { defineField, handleSubmit, errors, resetForm } = useForm({ validationSchema: schema, initialValues: { participantNo: '', identityKey: '', site: '上海中心', ageBand: '45-64', actor: '研究者张宁' } });
const [participantNo] = defineField('participantNo');
const [identityKey] = defineField('identityKey');
const [site] = defineField('site');
const [ageBand] = defineField('ageBand');
const [actor] = defineField('actor');
const actorName = computed(() => actor.value ?? '');

/**
 * 治疗组可见性（受控披露 + 角色边界）：
 * - 研究者：仅看到已揭盲受试者本人的治疗组，其余隐藏。
 * - 药品管理员：任何治疗组都不可见（角色边界），只见发药编号。
 * - 监察员：可见已揭盲受试者的治疗组（安全核查）。
 */
const visibleArm = (p: Participant): string => {
  if (role.value === 'pharmacist') return '已隐藏';
  if (p.status === 'unblinded') return p.arm ?? '未知';
  return '已隐藏';
};

/**
 * 发药编号可见性：
 * - 研究者：已揭盲受试者的同区组其他人，其发药编号继续隐藏，防止链接到具体药品包装。
 * - 药品管理员：可见发药编号（发药职责），但看不到治疗组。
 * - 监察员：可见。
 */
const hiddenSequenceIds = computed<Set<string>>(() => {
  if (role.value !== 'investigator') return new Set<string>();
  const hidden = new Set<string>();
  for (const p of participants.value) {
    if (p.status === 'unblinded') continue;
    const mates = blockMatesOf(p, participants.value);
    if (mates.some((mate) => mate.status === 'unblinded')) hidden.add(p.id);
  }
  return hidden;
});
const visibleSequence = (p: Participant): number | string => {
  if (role.value === 'investigator' && hiddenSequenceIds.value.has(p.id)) return '已隐藏';
  return p.sequence;
};

const submit = handleSubmit((values) => {
  const result = trial.randomize(values, offline.value);
  if (!result.ok) {
    ElMessage.error(result.message);
    return;
  }
  ElMessage.success(result.message);
  resetForm({ values: { participantNo: '', identityKey: '', site: values.site, ageBand: values.ageBand, actor: values.actor } });
});

const unblind = async (p: Participant) => {
  try {
    const { value } = await ElMessageBox.prompt(`为 ${p.participantNo} 填写紧急揭盲原因（仅披露该受试者治疗组）`, '紧急揭盲 · 受控披露', { inputType: 'textarea', inputValidator: (v) => Boolean(v?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' });
    const result = trial.requestUnblinding({ participantId: p.id, reason: value, actor: actorName.value });
    if (!result.ok) {
      ElMessage.error(result.message);
      return;
    }
    ElMessage.success(`${p.participantNo} 已揭盲，治疗组 ${result.arm}（仅披露该受试者本人）`);
  } catch {}
};

const withdraw = async (record: UnblindingRecord) => {
  try {
    const { value } = await ElMessageBox.prompt(`撤回 ${record.participantNo} 的揭盲并恢复盲态，请填写原因`, '撤回揭盲', { inputType: 'textarea', inputValidator: (v) => Boolean(v?.trim()) || '撤回原因不能为空', confirmButtonText: '确认撤回并恢复盲态' });
    const result = trial.withdrawUnblinding(record.id, actorName.value, value);
    if (!result.ok) ElMessage.error(result.message);
    else ElMessage.warning(result.message);
  } catch {}
};

const verify = async (record: UnblindingRecord, approved: boolean) => {
  if (approved) {
    const result = trial.verifyUnblinding(record.id, true, actorName.value);
    if (!result.ok) ElMessage.error(result.message);
    else ElMessage.success(result.message);
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt(`核查 ${record.participantNo} 的揭盲不成立，将恢复盲态，请填写说明`, '核查不成立', { inputType: 'textarea', inputValidator: (v) => Boolean(v?.trim()) || '请填写核查说明', confirmButtonText: '确认不成立并恢复盲态' });
    const result = trial.verifyUnblinding(record.id, false, actorName.value, value);
    if (!result.ok) ElMessage.error(result.message);
    else ElMessage.warning(result.message);
  } catch {}
};

const auditColor = (action: AuditAction): 'danger' | 'warning' | 'success' | 'primary' => {
  switch (action) {
    case 'unblinded':
    case 'unblind-rejected':
      return 'danger';
    case 'unblind-withdrawn':
    case 'duplicate-blocked':
      return 'warning';
    case 'unblind-verified':
    case 'pending-committed':
      return 'success';
    default:
      return 'primary';
  }
};

const recordStatusType = (record: UnblindingRecord): 'danger' | 'warning' | 'info' => {
  if (record.status === 'withdrawn') return 'info';
  return record.verification === 'rejected' ? 'warning' : 'danger';
};
const recordStatusText = (record: UnblindingRecord): string => {
  if (record.status === 'withdrawn') return '已撤回 · 盲态恢复';
  if (record.verification === 'confirmed') return '核查确认';
  if (record.verification === 'rejected') return '核查不成立';
  return '生效中 · 待核查';
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: activeUnblindings.value.length,
  sites: Object.keys(trial.bySite).length,
  pending: trial.pendingCount
}));
</script>

<template>
  <main class="page">
    <header class="hero">
      <div><el-tag type="success">GCP 本地原型</el-tag><h1>{{ t('title') }}</h1><p>{{ t('subtitle') }}</p></div>
      <el-segmented v-model="role" :options="[{ label: '研究者', value: 'investigator' }, { label: '药品管理员', value: 'pharmacist' }, { label: '监察员', value: 'monitor' }]" />
    </header>

    <section style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-bottom:20px">
      <div class="stat"><span>已随机入组</span><b>{{ counts.total }}</b></div>
      <div class="stat"><span>生效揭盲</span><b>{{ counts.unblinded }}</b></div>
      <div class="stat"><span>参与中心</span><b>{{ counts.sites }}</b></div>
      <div class="stat"><span>待提交</span><b>{{ counts.pending }}</b></div>
    </section>

    <div class="grid">
      <el-card shadow="never">
        <template #header><b>{{ t('randomize') }}</b><el-switch v-model="offline" active-text="模拟离线" style="float:right" /></template>
        <el-form label-position="top" @submit.prevent="submit">
          <el-form-item label="研究中心" :error="errors.site"><el-select v-model="site" style="width:100%"><el-option label="上海中心" value="上海中心" /><el-option label="广州中心" value="广州中心" /><el-option label="新加坡中心" value="新加坡中心" /></el-select></el-form-item>
          <el-form-item label="受试者编号" :error="errors.participantNo"><el-input v-model="participantNo" placeholder="S01-003" /></el-form-item>
          <el-form-item label="身份核验标识" :error="errors.identityKey"><el-input v-model="identityKey" placeholder="脱敏身份键或筛选号" /></el-form-item>
          <el-form-item label="年龄分层" :error="errors.ageBand"><el-radio-group v-model="ageBand"><el-radio-button value="18-44">18-44</el-radio-button><el-radio-button value="45-64">45-64</el-radio-button><el-radio-button value="65+">65+</el-radio-button></el-radio-group></el-form-item>
          <el-form-item label="操作人" :error="errors.actor"><el-input v-model="actor" /></el-form-item>
          <el-button type="primary" native-type="submit" style="width:100%">执行分层区组随机</el-button>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><div style="display:flex;justify-content:space-between"><b>{{ t('participants') }}</b><el-tag>{{ role }}</el-tag></div></template>
        <el-table :data="participants" max-height="480">
          <el-table-column prop="participantNo" label="受试者" min-width="110" />
          <el-table-column prop="site" label="中心" min-width="110" />
          <el-table-column label="发药编号" width="100"><template #default="{ row }"><span :style="visibleSequence(row as Participant) === '已隐藏' ? 'color:#b0c4ce' : ''">{{ visibleSequence(row as Participant) }}</span></template></el-table-column>
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row as Participant) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="100"><template #default="{ row }"><el-button v-if="role === 'investigator' && row.status !== 'unblinded'" size="small" type="danger" plain @click="unblind(row as Participant)">揭盲</el-button><el-tag v-else-if="row.status === 'unblinded'" type="danger" size="small">已揭盲</el-tag></template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>揭盲记录（仅追加）</b>
            <div>
              <el-switch v-model="persistFailureArmed" active-text="模拟写盘失败" inline-prompt style="margin-right:12px" />
              <el-button v-if="hasPendingWrites" size="small" type="warning" @click="trial.retryAllWrites()">重试写盘 {{ pendingWriteNos.length }}</el-button>
            </div>
          </div>
        </template>
        <el-empty v-if="unblindings.length === 0" description="暂无揭盲记录" />
        <el-table v-else :data="unblindings" max-height="360">
          <el-table-column label="申请编号" min-width="150"><template #default="{ row }"><span style="font-family:monospace;font-size:12px">{{ row.id.slice(0, 8) }}</span></template></el-table-column>
          <el-table-column prop="participantNo" label="受试者" min-width="100" />
          <el-table-column label="披露组别" width="90"><template #default="{ row }"><el-tag type="danger">{{ row.arm }}</el-tag></template></el-table-column>
          <el-table-column prop="reason" label="原因" min-width="140" show-overflow-tooltip />
          <el-table-column prop="applicant" label="申请人" width="100" />
          <el-table-column label="状态" min-width="130"><template #default="{ row }"><el-tag :type="recordStatusType(row as UnblindingRecord)" size="small">{{ recordStatusText(row as UnblindingRecord) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" min-width="200"><template #default="{ row }">
            <el-button v-if="row.status === 'active'" size="small" type="warning" plain @click="withdraw(row as UnblindingRecord)">撤回</el-button>
            <el-button v-if="row.status === 'active' && row.verification === 'pending'" size="small" type="success" plain @click="verify(row as UnblindingRecord, true)">核查确认</el-button>
            <el-button v-if="row.status === 'active' && row.verification === 'pending'" size="small" type="danger" plain @click="verify(row as UnblindingRecord, false)">核查不成立</el-button>
          </template></el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" />
          <el-table-column prop="status" label="状态" />
          <el-table-column label="操作"><template #default="{ row }"><el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actorName)">确认入库</el-button></template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <el-card shadow="never" style="margin-top:20px">
      <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
      <el-timeline>
        <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="auditColor(entry.action)">
          <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
