import { createRouter, createWebHashHistory } from "vue-router";

import ZoomView from "./views/ZoomView.vue";

/**
 * 使用 hash 路由：静态托管与本地中间件都不需要 SPA 回退规则，
 * 直接访问 /timeline/ 即可。旧的方案地址统一回到缩放轴。
 */
export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", name: "zoom", component: ZoomView },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
