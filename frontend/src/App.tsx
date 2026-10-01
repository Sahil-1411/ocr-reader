import { AppHeader, ExportDock, ResultPanel, TicketPanel, useReceiptSession } from './modules/app'

export default function App() {
  const session = useReceiptSession()

  return (
    <div className="app">
      {/* Until something has been read there is nothing to export, and the
          header is just the title. */}
      {session.exportPages.length > 0 ? (
        <ExportDock
          pages={session.exportPages}
          total={session.isPdfMode ? session.pdfPages.length : 1}
          failures={session.failures}
          reading={session.busy}
          fileName={session.fileName}
        />
      ) : (
        <div className="app__top">
          <AppHeader />
        </div>
      )}
      <div className="app__grid">
        <TicketPanel session={session} />
        <ResultPanel session={session} />
      </div>
    </div>
  )
}
