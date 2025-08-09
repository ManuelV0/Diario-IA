import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import PublicAuthorPage from './PublicAuthorPage'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/autore/:id" element={<PublicAuthorPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
)
