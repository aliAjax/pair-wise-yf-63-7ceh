<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useTrialStore } from '~/stores/trial';
import type { Participant, TrialRole } from '~/types/trial';

const { t } = useI18n();
const trial = useTrialStore();
const { participants, audits, pending, unblindings, debugFailPersist } = storeToRefs(trial);
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

/** 受控披露：药品管理员按角色边界永不可见组别；其余角色也仅能看到已揭盲受试者本人的组别 */
const visibleArm = (row: Participant) => {
  if (role.value === 'pharmacist') return '已隐藏';
  if (row.status === 'unblinded') return row.arm ?? '未知';
  return '已隐藏';
};

/** 存在生效中揭盲的区组：同区组其他受试者的发药编号一并遮蔽，防止由配对关系反推组别 */
const hotBlocks = computed(() => new Set(participants.value.filter((item) => item.status === 'unblinded').map((item) => item.blockId)));
const visibleKit = (row: Participant) => {
  if (row.status !== 'unblinded' && hotBlocks.value.has(row.blockId)) return '已保护';
  return row.kitNo;
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

const unblind = async (id: string, participantNumber: string) => {
  const operator = actor.value?.trim();
  if (!operator) {
    ElMessage.error('请先在左侧表单填写操作人，揭盲必须署名');
    return;
  }
  let reason: string;
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写紧急揭盲原因（仅披露该受试者治疗组）`, '紧急揭盲 · 受控披露', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '揭盲原因不能为空', confirmButtonText: '确认并审计' });
    reason = value;
  } catch { return; }
  // 一次申请固定一个申请编号：写盘失败按原编号重试，不会重复记账
  const requestId = `UB-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  let result = trial.requestUnblind({ requestId, participantId: id, reason, actor: operator });
  while (!result.ok && result.retryable) {
    try {
      await ElMessageBox.confirm(`写入失败，本次未记账。是否按申请编号 ${requestId} 重试？`, '揭盲写入失败', { confirmButtonText: '按原申请编号重试', cancelButtonText: '放弃', type: 'error' });
    } catch {
      ElMessage.info(`已放弃，申请 ${requestId} 未记账`);
      return;
    }
    result = trial.requestUnblind({ requestId, participantId: id, reason, actor: operator });
  }
  if (result.ok) ElMessage.warning(result.message);
  else ElMessage.error(result.message);
};

const restore = async (id: string, participantNumber: string) => {
  const operator = actor.value?.trim();
  if (!operator) {
    ElMessage.error('请先在左侧表单填写操作人，恢复盲态必须署名');
    return;
  }
  try {
    const { value } = await ElMessageBox.prompt(`为 ${participantNumber} 填写恢复盲态原因（撤回 / 核查不成立）`, '恢复盲态', { inputType: 'textarea', inputValidator: (value) => Boolean(value?.trim()) || '原因不能为空', confirmButtonText: '确认恢复并审计' });
    const result = trial.restoreBlind({ participantId: id, reason: value, actor: operator });
    if (result.ok) ElMessage.success(result.message);
    else ElMessage.error(result.message);
  } catch {}
};

const counts = computed(() => ({
  total: participants.value.length,
  unblinded: participants.value.filter((item) => item.status === 'unblinded').length,
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
      <div class="stat"><span>紧急揭盲</span><b>{{ counts.unblinded }}</b></div>
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
          <el-table-column prop="participantNo" label="受试者" min-width="100" />
          <el-table-column prop="site" label="中心" min-width="100" />
          <el-table-column label="区组" width="70"><template #default="{ row }">{{ (row as Participant).blockId.split('|').pop() }}</template></el-table-column>
          <el-table-column label="发药编号" width="110"><template #default="{ row }"><el-tag :type="visibleKit(row as Participant) === '已保护' ? 'warning' : 'info'">{{ visibleKit(row as Participant) }}</el-tag></template></el-table-column>
          <el-table-column label="治疗组" width="100"><template #default="{ row }"><el-tag :type="row.status === 'unblinded' ? 'danger' : 'info'">{{ visibleArm(row as Participant) }}</el-tag></template></el-table-column>
          <el-table-column label="操作" width="130"><template #default="{ row }">
            <el-button v-if="role === 'investigator' && row.status !== 'unblinded'" size="small" type="danger" plain @click="unblind(row.id, row.participantNo)">揭盲</el-button>
            <el-button v-if="role !== 'pharmacist' && row.status === 'unblinded'" size="small" type="success" plain @click="restore(row.id, row.participantNo)">恢复盲态</el-button>
          </template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <div class="grid" style="margin-top:20px">
      <el-card shadow="never">
        <template #header><b>{{ t('pending') }}</b></template>
        <el-empty v-if="pending.length === 0" description="暂无待提交记录" />
        <el-table v-else :data="pending">
          <el-table-column prop="payload.participantNo" label="受试者" />
          <el-table-column prop="status" label="状态" />
          <el-table-column label="操作"><template #default="{ row }"><el-button :disabled="row.status !== 'pending'" size="small" type="primary" @click="trial.commitPending(row.id, actor ?? '')">确认入库</el-button></template></el-table-column>
        </el-table>
      </el-card>
      <el-card shadow="never">
        <template #header><b>{{ t('ledger') }}</b><el-switch v-model="debugFailPersist" active-text="模拟写盘失败" style="float:right;margin-left:12px" /><el-tag type="warning" style="float:right">仅追加</el-tag></template>
        <el-empty v-if="unblindings.length === 0" description="暂无揭盲记录" />
        <el-table v-else :data="unblindings" max-height="300">
          <el-table-column prop="requestId" label="申请编号" width="130" />
          <el-table-column prop="participantNo" label="受试者" width="90" />
          <el-table-column label="事件" width="100"><template #default="{ row }"><el-tag :type="row.kind === 'disclose' ? 'danger' : 'success'">{{ row.kind === 'disclose' ? '受控披露' : '恢复盲态' }}</el-tag></template></el-table-column>
          <el-table-column prop="reason" label="原因" min-width="160" show-overflow-tooltip />
          <el-table-column prop="actor" label="操作人" width="110" />
          <el-table-column label="关联申请" width="130"><template #default="{ row }">{{ row.reversesRequestId ?? '—' }}</template></el-table-column>
        </el-table>
      </el-card>
    </div>

    <el-card shadow="never" style="margin-top:20px">
      <template #header><b>{{ t('audit') }}</b><el-tag type="warning" style="float:right">仅追加</el-tag></template>
      <el-timeline>
        <el-timeline-item v-for="entry in audits" :key="entry.id" :timestamp="new Date(entry.at).toLocaleString()" :type="entry.action === 'unblinded' ? 'danger' : entry.action === 'blind-restored' ? 'success' : entry.action === 'duplicate-blocked' ? 'warning' : 'primary'">
          <b>{{ entry.actor }} · {{ entry.action }}</b><div>{{ entry.detail }}</div>
        </el-timeline-item>
      </el-timeline>
    </el-card>
  </main>
</template>

<style scoped>
@media (max-width: 900px) { section { grid-template-columns: 1fr 1fr !important; } }
</style>
