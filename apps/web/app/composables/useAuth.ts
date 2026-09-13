import type { Permission, User } from '@kh/shared';

/**
 * 登录态与权限。
 *
 * 权限来自后端，前端只做「按钮显不显示」的界面收敛 ——
 * 真正的拦截在后端守卫里，前端藏按钮只是体验优化，不是安全措施。
 */
export function useAuth() {
  const api = useApi();
  const user = useState<User | null>('auth:user', () => null);
  const resolved = useState<boolean>('auth:resolved', () => false);

  async function fetchMe(): Promise<User | null> {
    try {
      user.value = await api.me();
    } catch {
      user.value = null;
    } finally {
      resolved.value = true;
    }
    return user.value;
  }

  async function login(account: string, password: string): Promise<User> {
    const res = await api.login(account, password);
    user.value = res.user;
    resolved.value = true;
    return res.user;
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      user.value = null;
      resolved.value = true;
    }
  }

  /** 是否具备某项能力，用于控制按钮显隐 */
  function can(permission: Permission): boolean {
    return !!user.value?.permissions?.includes(permission);
  }

  return { user, resolved, fetchMe, login, logout, can };
}
