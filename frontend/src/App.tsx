import { AppHeader, ResultPanel, TicketPanel, useReceiptSession } from './modules/app'

export default function App() {
  const session = useReceiptSession()

  return (
    <div className="app">
      <AppHeader />
      <div className="app__grid">
        <TicketPanel session={session} />
        <ResultPanel session={session} />
      </div>
    </div>
  )
}
