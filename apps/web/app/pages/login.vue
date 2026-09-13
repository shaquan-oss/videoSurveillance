<script setup lang="ts">
definePageMeta({ layout: false });

const api = useApi();
const { login } = useAuth();
const route = useRoute();
const router = useRouter();

const account = ref('');
const password = ref('');
const loading = ref(false);
const errorMsg = ref('');

/** 开发演示用的账号，点一下自动填入 */
const demoAccounts = [
  {
    account: 'admin',
    password: 'Admin@2026',
    label: '系统管理员',
    dept: '综合部',
  },
  {
    account: 'finance01',
    password: 'Test@2026',
    label: '财务部主管',
    dept: '财务部',
  },
  {
    account: 'tech01',
    password: 'Test@2026',
    label: '技术部成员',
    dept: '技术部',
  },
];

function fill(a: { account: string; password: string }) {
  account.value = a.account;
  password.value = a.password;
  errorMsg.value = '';
}

async function onSubmit() {
  if (loading.value) return;
  errorMsg.value = '';
  loading.value = true;
  try {
    await login(account.value.trim(), password.value);
    const redirect = route.query.redirect;
    await router.push(typeof redirect === 'string' ? redirect : '/');
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="wrap">
    <div class="brand-side">
      <div class="brand-inner">
        <div class="mark" />
        <h1>企业智能知识中枢</h1>
        <p class="sub">
          类 NAS 的文件底座 + 挂在九天大模型上的智能体门户。<br>
          存文件、找文件、问制度、办事情，都在一个入口完成。
        </p>
        <ul class="points">
          <li><b>文件即知识</b>：上传的文件勾一下就能被智能体引用，回答带出处</li>
          <li><b>权限在检索前生效</b>：没有权限的内容不会进入模型上下文</li>
          <li><b>多模型可选</b>：聚智平台模型统一接入，坏一个自动切备用</li>
        </ul>
        <div class="stage">当前阶段：一 · 账号与文件管理</div>
      </div>
    </div>

    <div class="form-side">
      <form class="login-box" @submit.prevent="onSubmit">
        <h2>登录</h2>
        <p class="hint-line">使用公司账号登录，或点下方演示账号自动填入。</p>

        <div v-if="errorMsg" class="alert err">
          <span>{{ errorMsg }}</span>
        </div>

        <div class="field">
          <label for="acc">账号</label>
          <input id="acc" v-model="account" autocomplete="username" placeholder="工号或账号" />
        </div>

        <div class="field">
          <label for="pwd">密码</label>
          <input id="pwd" v-model="password" type="password" autocomplete="current-password" placeholder="密码" />
        </div>

        <button class="btn primary lg submit" type="submit" :disabled="loading || !account || !password">
          {{ loading ? '正在登录…' : '登录' }}
        </button>

        <div class="demo">
          <div class="demo-label">演示账号（点一下自动填入）</div>
          <button
            v-for="d in demoAccounts"
            :key="d.account"
            class="demo-item"
            type="button"
            @click="fill(d)"
          >
            <span class="di-name">{{ d.label }}</span>
            <span class="di-acc mono">{{ d.account }}</span>
            <span class="di-dept">{{ d.dept }}</span>
          </button>
          <p class="demo-note">
            三个账号的可见范围不同，可用于验证权限边界：财务部限定文件，技术部同事看不到。
          </p>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.wrap { display: flex; height: 100vh; }

.brand-side {
  flex: 1.05; background: var(--nav-bg); color: #fff;
  display: flex; align-items: center; padding: 60px;
}
.brand-inner { max-width: 520px; }
.mark {
  width: 44px; height: 44px; border-radius: 12px; margin-bottom: 26px;
  background: linear-gradient(135deg, #2E7CF6, #25C1A0);
}
.brand-inner h1 { font-size: 30px; font-weight: 600; margin: 0 0 14px; letter-spacing: -.025em; }
.sub { font-size: 14px; line-height: 1.85; color: #A9B6C7; margin: 0 0 30px; }
.points { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 13px; }
.points li {
  font-size: 13px; color: #C8D3E0; padding-left: 20px; position: relative; line-height: 1.7;
}
.points li::before {
  content: ''; position: absolute; left: 0; top: 8px;
  width: 7px; height: 7px; border-radius: 2px; background: var(--b500);
}
.points b { color: #fff; font-weight: 500; }
.stage {
  margin-top: 34px; padding-top: 20px; font-size: 12px; color: #7C8DA3;
  border-top: 1px solid rgba(255, 255, 255, .08);
}

.form-side {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 40px; background: var(--paper);
}
.login-box { width: 100%; max-width: 380px; }
.login-box h2 { font-size: 22px; font-weight: 600; margin: 0 0 6px; letter-spacing: -.02em; }
.hint-line { font-size: 13px; color: var(--ink-3); margin: 0 0 22px; }
.submit { width: 100%; justify-content: center; margin-top: 4px; }

.demo { margin-top: 30px; padding-top: 20px; border-top: 1px solid var(--line); }
.demo-label { font-size: 11.5px; color: var(--ink-3); margin-bottom: 10px; }
.demo-item {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 9px 11px; margin-bottom: 6px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-sm); font-family: inherit; font-size: 12.5px;
  color: var(--ink); transition: all var(--t); text-align: left;
}
.demo-item:hover { border-color: var(--brand-line); background: var(--brand-s); }
.di-name { font-weight: 500; width: 84px; }
.di-acc { color: var(--ink-3); flex: 1; }
.di-dept { color: var(--ink-3); font-size: 11.5px; }
.demo-note { font-size: 11.5px; color: var(--ink-3); margin: 12px 0 0; line-height: 1.7; }

@media (max-width: 900px) {
  .brand-side { display: none; }
}
</style>
