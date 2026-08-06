import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App.tsx'
import { MarkdownParser } from './core/parser'
import { MarkdownFormatChecker } from './core/validator'

(window as any).MarkdownParser = MarkdownParser;
(window as any).MarkdownFormatChecker = MarkdownFormatChecker;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
