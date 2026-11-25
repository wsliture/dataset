
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Link, matchPath, Navigate, NavLink, Outlet, RouterProvider, useLocation } from 'react-router-dom'
import { Database, Layers3, Search, Settings } from 'lucide-react'
import { AnnotationPage } from './annotation'
import { CasesPage } from './cases'
import { DatasetLayout, DatasetsPage } from './datasets'
import { DocumentsPage } from './documents'
import { EmbeddingSettingsPage } from './embedding-settings'
import { createHttpClient } from './http'
import { ChatProvider, SearchPage } from './search'
import { ClientContext, Empty } from './ui'
import './styles.css'

function Layout() {
  const { pathname, search, hash } = useLocation()
  const datasetPage = matchPath('/datasets/*', pathname) ? pathname + search + hash : null
  const [lastDatasetPage, setLastDatasetPage] = useState(datasetPage ?? '/datasets')

  useEffect(() => {
    if (datasetPage) setLastDatasetPage(datasetPage)
  }, [datasetPage])

  return <ChatProvider>
    <a className="skip-link" href="#main">跳至主要内容</a>
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/datasets" className="brand"><span className="brand-mark"><Layers3 size={21} /></span><span>历史案例标注平台</span></Link>
        <nav aria-label="主导航">
          <NavLink to={datasetPage ? '/datasets' : lastDatasetPage}><Database size={16} />历史数据集</NavLink>
          <NavLink to="/search"><Search size={17} />案例检索</NavLink>
          <NavLink to="/settings/embedding"><Settings size={17} />模型设置</NavLink>
        </nav>
      </div>
    </header>
    <div id="main"><Outlet /></div>
  </ChatProvider>
}
const router = createBrowserRouter([{
  element: <Layout />,
  children: [
    { index: true, element: <Navigate to="/datasets" replace /> },
    { path: 'datasets', element: <DatasetsPage /> },
    { path: 'datasets/:datasetId', element: <DatasetLayout />, children: [
      { index: true, element: <Navigate to="documents" replace /> },
      { path: 'documents', element: <DocumentsPage /> },
      { path: 'annotation', element: <AnnotationPage /> },
      { path: 'cases', element: <CasesPage /> },
    ] },
    { path: 'search', element: <SearchPage /> },
    { path: 'settings/embedding', element: <EmbeddingSettingsPage /> },
    { path: '*', element: <main className="container"><Empty title="页面不存在"><Link to="/datasets">返回数据集</Link></Empty></main> },
  ],
}])
const client = createHttpClient()
createRoot(document.getElementById('root')!).render(<ClientContext.Provider value={client}><RouterProvider router={router} /></ClientContext.Provider>)
