/**
 * 全局登录守卫。
 * 未登录时一律跳登录页，并记住原本要去的地方，登录后跳回去。
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (to.path === '/login') return;

  const { user, resolved, fetchMe } = useAuth();

  if (!resolved.value) {
    await fetchMe();
  }

  if (!user.value) {
    return navigateTo({
      path: '/login',
      query: to.fullPath !== '/' ? { redirect: to.fullPath } : {},
    });
  }
});
