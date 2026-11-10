export function createRoutes({ pilot = false } = {}) {
  return [
    { path: '/', component: () => import('../views/Portal.vue'), meta: { title: '欢迎' } },
    { path: '/login', component: () => import('../views/Login.vue'), meta: { title: '登录' } },
    { path: '/register', component: () => import('../views/Login.vue'), meta: { title: '注册' } },
    { path: '/help', component: () => import('../views/Support.vue'), meta: { title: '帮助' } },
    { path: '/privacy', component: () => import('../views/Support.vue'), meta: { title: '隐私说明' } },
    {
      path: '/app', component: () => import('../layout/AdminLayout.vue'), redirect: pilot ? '/recognize' : '/home', meta: { requiresAuth: true },
      children: [
        { path: '/home', component: () => import('../views/Home.vue'), meta: { title: '工作空间' } },
        { path: '/recognize', component: () => import('../views/Recognize.vue'), meta: { title: pilot ? '画板' : '手写识别' } },
        { path: '/account', component: () => import('../views/Account.vue'), meta: { title: '账号' } },
        { path: '/assets', component: () => import('../views/Assets.vue'), meta: { title: '公共资产' } },
        { path: '/usage', component: () => import('../views/Usage.vue'), meta: { title: '我的空间用量' } },
        { path: '/training', component: () => import('../views/Training.vue'), meta: { title: '训练任务' } },
        { path: '/statistics', component: () => import('../views/Statistics.vue'), meta: { title: '统计' } },
        { path: '/models', component: () => import('../views/Models.vue'), meta: { title: '模型管理', superAdmin: true } },
        { path: '/platform', component: () => import('../views/Platform.vue'), meta: { title: '平台运行状态', superAdmin: true } }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
}

export function navigationLinks({ pilot = false, superAdmin = false } = {}) {
  if (pilot) return [['/recognize', '画板'], ['/account', '账号'], ['/help', '帮助'], ['/privacy', '隐私说明']]
  return [
    ['/home', '工作空间'], ['/recognize', '手写识别'], ['/assets', '公共资产'],
    ['/usage', '我的用量'], ['/training', '训练任务'], ['/statistics', '统计'],
    ...(superAdmin ? [['/models', '模型管理'], ['/platform', '平台运行状态']] : [])
  ]
}
