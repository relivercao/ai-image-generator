import express from 'express'
import {
  archiveJobImages,
  createJob,
  downloadAsset,
  getJob,
  listRecoverableJobs,
  updateJob,
} from '../controllers/generationJobController.js'
import { authenticateToken } from '../middleware/auth.js'

const router = express.Router()

router.use(authenticateToken)
router.use((req, res, next) => {
  if (req.app.locals.generationArchiveReady) return next()
  return res.status(503).json({
    error: 'Generation archive unavailable',
    message: '图片归档服务暂不可用，登录和生图接口不受影响',
  })
})
router.get('/recoverable', listRecoverableJobs)
router.post('/', createJob)
router.get('/:id', getJob)
router.patch('/:id', updateJob)
router.post('/:id/archive', archiveJobImages)
router.get('/:id/assets/:assetId', downloadAsset)

export default router
