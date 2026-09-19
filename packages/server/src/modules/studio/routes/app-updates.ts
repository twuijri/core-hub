import Router from '@koa/router'
import * as ctrl from '../controllers/app-updates'
import { requireSuperAdmin } from '../middleware/super-admin'

export const appUpdateRoutes = new Router()

// Any authenticated caller, including the phone's device-bound App token.
appUpdateRoutes.get('/api/studio/app-updates/mobile', ctrl.checkMobile)
appUpdateRoutes.get('/api/studio/app-updates/mobile/download', ctrl.downloadMobile)

// Reading never echoes the GitHub token; writing it is owner-only.
appUpdateRoutes.get('/api/studio/app-updates/settings', ctrl.getSettings)
appUpdateRoutes.put('/api/studio/app-updates/settings', requireSuperAdmin, ctrl.saveSettings)
appUpdateRoutes.delete('/api/studio/app-updates/settings/token', requireSuperAdmin, ctrl.deleteToken)
