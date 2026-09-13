<script setup lang="ts">
const { user, logout } = useAuth();
const route = useRoute();
const router = useRouter();

/**
 * 导航按「用户动作」组织，不按系统模块。
 * 阶段一只启用前两项，其余预留并标注「后续阶段」，避免点进去是空的。
 */
const navGroups = [
  {
    label: '常用',
    items: [
      {
        key: 'workbench',
        label: '工作台',
        to: '/',
        icon: 'M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z',
        ready: true,
      },
      {
        key: 'files',
        label: '文件管理',
        to: '/files',
        icon: 'M3 5a2 2 0 012-2h3.6l1.7 2H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2z',
        ready: true,
      },
      {
        key: 'kb',
        label: '知识库',
        to: '/kb',
        icon: 'M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3z',
        ready: true,
      },
      {
        key: 'chat',
        label: '智能体对话',
        to: '/chat',
        icon: 'M21 12a8 8 0 11-3.2-6.4L21 4l-1 3.2A7.8 7.8 0 0121 12z',
        ready: true,
      },
    ],
  },
  {
    label: '能力',
    items: [
      {
        key: 'agents',
        label: '智能体',
        to: '/agents',
        icon: 'M9 3h6v4H9zM4 9h16v10H4z',
        ready: true,
      },
      {
        key: 'tasks',
        label: '定时任务',
        to: '/tasks',
        icon: 'M12 3a9 9 0 109 9h-9zM12 3v9l6.4 6.4',
        ready: true,
      },
      {
        key: 'skills',
        label: '技能商城',
        to: '/skills',
        icon: 'M12 2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 7.7l5.4-.8z',
        ready: true,
      },
    ],
  },
  {
    label: '系统',
    items: [
      {
        key: 'admin',
        label: '管理后台',
        to: '/admin',
        icon: 'M12 3l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V7z',
        ready: true,
      },
    ],
  },
];

const pageTitle = computed(() => {
  const flat = navGroups.flatMap((g) => g.items);
  return flat.find((i) => i.to === route.path)?.label ?? '企业智能知识中枢';
});

async function onLogout() {
  await logout();
  await router.push('/login');
}
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <div class="logo">
        <span class="logo-mark" />
        <span class="logo-text">企业智能知识中枢</span>
      </div>

      <nav class="nav">
        <template v-for="g in navGroups" :key="g.label">
          <div class="nav-label">{{ g.label }}</div>
          <NuxtLink
            v-for="item in g.items"
            :key="item.key"
            :to="item.ready ? item.to : '#'"
            class="ni"
            :class="{ active: route.path === item.to, disabled: !item.ready }"
            :aria-disabled="!item.ready"
            @click="!item.ready && $event.preventDefault()"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path :d="item.icon" />
            </svg>
            <span>{{ item.label }}</span>
          </NuxtLink>
        </template>
      </nav>

      <div class="side-foot">
        <div class="foot-row">
          <span class="dot-live" />
          <span>开发环境 · 本机</span>
        </div>
        <div class="tiny">存储：MinIO ｜ 模型：聚智 OpenAPI</div>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="crumb">
          <span class="crumb-page">{{ pageTitle }}</span>
        </div>
        <div class="spacer" />
        <div v-if="user" class="user-box">
          <span class="uname">{{ user.name }}</span>
          <span class="tiny">{{ user.departmentName ?? '未归属部门' }}</span>
          <button class="btn sm" @click="onLogout">退出</button>
        </div>
      </header>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; height: 100vh; overflow: hidden; }

.sidebar {
  width: 222px; flex-shrink: 0; background: var(--nav-bg);
  display: flex; flex-direction: column; color: var(--nav-tx);
}
.logo {
  padding: 18px 18px 16px; display: flex; align-items: center; gap: 10px;
  color: #fff; font-size: 14.5px; font-weight: 500;
}
.logo-mark {
  width: 24px; height: 24px; border-radius: 7px; flex-shrink: 0;
  background: linear-gradient(135deg, #2E7CF6, #25C1A0);
}
.logo-text { letter-spacing: -.01em; }

.nav { padding: 4px 10px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.nav-label {
  font-size: 11px; color: #5A6B80; padding: 14px 11px 6px;
  letter-spacing: .04em;
}
.ni {
  position: relative; display: flex; align-items: center; gap: 10px;
  padding: 8.5px 11px; border-radius: var(--r-sm); cursor: pointer;
  color: var(--nav-tx); font-size: 13.5px; text-decoration: none;
  transition: background var(--t), color var(--t);
}
.ni:hover { background: rgba(255, 255, 255, .06); color: #D9E1EC; text-decoration: none; }
.ni.active { background: rgba(255, 255, 255, .10); color: #fff; font-weight: 500; }
/* 激活态用左侧竖条而不是整块高亮色块，收敛视觉噪音 */
.ni.active::before {
  content: ''; position: absolute; left: -10px; top: 50%; transform: translateY(-50%);
  width: 2px; height: 18px; border-radius: 0 2px 2px 0; background: var(--b500);
}
.ni.disabled { opacity: .42; cursor: not-allowed; }
.ni.disabled:hover { background: transparent; color: var(--nav-tx); }

.side-foot {
  margin-top: auto; padding: 14px 18px;
  border-top: 1px solid rgba(255, 255, 255, .07);
  display: flex; flex-direction: column; gap: 4px;
}
.foot-row { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: #7C8DA3; }
.dot-live { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }
.side-foot .tiny { color: #5A6B80; font-size: 11px; }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--paper); }
.topbar {
  height: 56px; flex-shrink: 0; display: flex; align-items: center; gap: 14px;
  padding: 0 26px; background: var(--surface); border-bottom: 1px solid var(--line);
}
.crumb { font-size: 14.5px; font-weight: 500; letter-spacing: -.01em; }
.user-box { display: flex; align-items: center; gap: 10px; }
.uname { font-size: 13px; font-weight: 500; }

.content { flex: 1; overflow: auto; padding: 26px 28px 40px; }
</style>
