import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { AppDataProvider } from './useAppData'
import { Dashboard } from '@/features/projections/Dashboard'
import { TransactionList } from '@/features/transactions/TransactionList'
import { BudgetScreen } from '@/features/budget/BudgetScreen'
import { ImportScreen } from '@/features/import/ImportScreen'
import { SettingsScreen } from '@/features/settings/SettingsScreen'

/**
 * HashRouter rather than BrowserRouter: the app is deployed as static files
 * and must work from any path (including file://) without server-side rewrite
 * rules for deep links.
 */
export function App() {
  return (
    <AppDataProvider>
      <HashRouter>
        <div className="min-h-full">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<TransactionList />} />
            <Route path="/budget" element={<BudgetScreen />} />
            <Route path="/import" element={<ImportScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <TabBar />
        </div>
      </HashRouter>
    </AppDataProvider>
  )
}

const TABS = [
  { to: '/', label: 'Overblik', icon: '📊' },
  { to: '/transactions', label: 'Poster', icon: '📋' },
  { to: '/budget', label: 'Budget', icon: '🎯' },
  { to: '/import', label: 'Importér', icon: '📥' },
  { to: '/settings', label: 'Mere', icon: '⚙️' },
]

function TabBar() {
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-white/95 backdrop-blur dark:border-ink-800 dark:bg-ink-900/95"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <ul className="flex">
        {TABS.map((tab) => (
          <li key={tab.to} className="flex-1">
            <NavLink
              to={tab.to}
              end={tab.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition ${
                  isActive ? 'text-ink-900 dark:text-white' : 'text-ink-400'
                }`
              }
            >
              <span className="text-lg" aria-hidden>
                {tab.icon}
              </span>
              {tab.label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
