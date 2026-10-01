import { ExportDock } from './components/ResultView'
import { AppHeader, ResultPanel, TicketPanel, useReceiptSession } from './modules/app'

export default function App() {
  const session = useReceiptSession()
  const header = <AppHeader />

  return (
    <div className="app">
      {session.exportPages.length > 0 ? (
        <ExportDock
          header={header}
          pages={session.exportPages}
          total={session.isPdfMode ? session.pdfPages.length : 1}
          failures={session.failures}
          reading={session.busy}
          fileName={session.fileName}
        />
      ) : (
        <div className="app__top">{header}</div>
      )}
      <div className="app__grid">
        <TicketPanel session={session} />
        <ResultPanel session={session} />
      </div>
    </div>
  )
}
