import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import PptApp from './PptApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PptApp />
  </StrictMode>,
)
