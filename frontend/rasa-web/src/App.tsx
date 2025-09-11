import { motion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';




type Tag = { id?: string; slug: string; title: string }
type Movie = { id: string; jellyfinId: string; title: string; posterUrl?: string; tags?: Tag[] }
type MoodBuckets = Record<string, { title: string, description: string }>
type SyncStatus = {
  isRunning: boolean
  lastSyncAt?: string
  lastSyncDuration?: number
  moviesFound: number
  moviesUpdated: number
  moviesDeleted: number
  errors: string[]
}
type ImportProgress = {
  total: number
  processed: number
  success: number
  fail: number
  running: boolean
}

const API = '/api/v1'

export default function App() {
  const [movies, setMovies] = useState<Movie[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [mood, setMood] = useState('')
  const [moods, setMoods] = useState<MoodBuckets>({})
  const [editingMovie, setEditingMovie] = useState<Movie | null>(null)
  const [showApiKeys, setShowApiKeys] = useState(false)
  const [autoTaggerOpen, setAutoTaggerOpen] = useState(false)
  const [autoTagIndex, setAutoTagIndex] = useState(0)
  const [autoTagging, setAutoTagging] = useState(false)
  const [autoSuggestion, setAutoSuggestion] = useState<{ suggestions: string[]; confidence: number; reasoning?: string } | null>(null)
  const [autoError, setAutoError] = useState<string | null>(null)
  const [selectedAutoTags, setSelectedAutoTags] = useState<string[]>([])
  const [autoQueue, setAutoQueue] = useState<string[]>([])
  const [currentAutoId, setCurrentAutoId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [syncActive, setSyncActive] = useState(false)
  const syncTimerRef = useRef<number | null>(null)
  const syncStartTsRef = useRef<number | null>(null)
  const [importProg, setImportProg] = useState<ImportProgress | null>(null)
  // Removed old batch tagging flow to simplify UI
  const importInputRef = useRef<HTMLInputElement>(null)
  const [version, setVersion] = useState<string>("")

  // Emoji map for moods (fallback to 🎬)
  const moodEmojiMap = useMemo<Record<string, string>>(() => ({
    // Genres / moods (add as many slugs as you like; case-insensitive checks below)
    all: '🧺',
    comedy: '😂',
    funny: '😄',
    humor: '🤣',
    drama: '🎭',
    thrillers: '😱',
    thriller: '😱',
    horror: '👻',
    fantasy: '🪄',
    history: '🏛️',
    crime: '🕵️',
    cartoon: '🐻',
    cartoons: '🐻',
    animation: '🎨',
    action: '💥',
    adventure: '🗺️',
    romance: '💘',
    scifi: '🚀',
    sci_fi: '🚀',
    sciencefiction: '🚀',
    documentary: '🎬',
    family: '👨‍👩‍👧‍👦',
    kids: '🧸',
    mystery: '🕵️‍♀️',
    war: '🪖',
    western: '🤠',
    music: '🎵',
    sport: '🏅',
    sports: '🏅',
  }), []);

  function getMoodEmoji(slug: string, title?: string) {
    const key = (slug || title || '').toLowerCase().replace(/\s+/g, '')
    return moodEmojiMap[key] || '🎬'
  }

  useEffect(() => { fetchMoods(); fetchAllMovies(); fetchVersion() }, [])

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...init })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }

  async function fetchMoods() {
    const data = await api<{ moods: MoodBuckets }>('/moods')
    setMoods(data.moods)
  }

  async function fetchAllMovies() {
    setLoading(true)
    try {
      // Fetch all movies at once with a high limit
      const data = await api<{ movies: Movie[] }>(`/movies?with_tags=true&limit=10000&offset=0`)
      setMovies(data.movies)
    } catch (error) {
      console.error('Failed to fetch movies:', error)
    } finally {
      setLoading(false)
    }
  }

  async function fetchVersion() {
    try {
      const res = await fetch('/version', { headers: { 'Content-Type': 'application/json' } })
      if (!res.ok) return
      const j = await res.json()
      if (j && typeof j.version === 'string') setVersion(j.version)
    } catch {}
  }

  async function pollSyncStatusOnce() {
    try {
      const status = await api<SyncStatus>("/sync/status");
      // setSyncStatus(status);

      const startedAt = syncStartTsRef.current || 0;
      const withinGrace = Date.now() - startedAt < 12000; // 12s grace

      // Drive visibility directly from status/grace
      setSyncActive(status.isRunning || withinGrace);

      if (!status.isRunning && !withinGrace) {
        setLoading(false);
        if (syncTimerRef.current) {
          window.clearTimeout(syncTimerRef.current);
          syncTimerRef.current = null;
        }
        await fetchAllMovies();
        return;
      }
    } catch {
      // keep polling on transient errors
    }
    // schedule next tick
    syncTimerRef.current = window.setTimeout(pollSyncStatusOnce, 1000);
  }

  async function syncAll() {
    try {
      setSyncActive(true)
      syncStartTsRef.current = Date.now()
      // fire-and-forget start; show banner immediately and poll
      fetch(API + '/sync/jellyfin', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => {})
      if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current)
      pollSyncStatusOnce()
    } catch (error) {
      console.error('Failed to sync:', error)
      setSyncActive(false)
    }
  }

  async function saveTags(movie: Movie, selectedTags: string[]) {
    try {
      // Server now allows empty tag arrays → send exactly what the user selected
      await api(`/movies/${movie.id}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tagSlugs: selectedTags, replaceAll: true })
      })
      await fetchAllMovies()
      setEditingMovie(null)
    } catch (error: any) {
      console.error('Failed to save tags:', error)
      alert('Failed to save tags. Please try again.')
    }
  }

  async function removeTag(movie: Movie, tagSlug: string) {
    try {
      const remainingTags = (movie.tags || []).filter(t => t.slug !== tagSlug).map(t => t.slug)
      await api(`/movies/${movie.id}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tagSlugs: remainingTags, replaceAll: true })
      })
      await fetchAllMovies()
    } catch (error: any) {
      console.error('Failed to remove tag:', error)
      alert('Failed to remove tag. Please try again.')
    }
  }
  
  async function autoTag(movie: Movie) {
    try {
      setLoading(true)
      await api(`/movies/${movie.id}/auto-tag`, { method: 'POST', body: JSON.stringify({ provider: 'anthropic', suggestionsOnly: false }) })
      await fetchAllMovies() // Refresh to show new tags
    } catch (error: any) {
      console.error('Failed to auto-tag:', error)
      let message = 'Failed to auto-tag movie.'
      
      if (error.message?.includes('429')) {
        message = 'Anthropic API rate limit reached. Please wait a moment and try again.'
      } else if (error.message?.includes('401') || error.message?.includes('Invalid API key')) {
        message = 'Invalid Anthropic API key. Please check your API key settings.'
      } else if (error.message?.includes('Internal Server Error')) {
        message = 'Anthropic API error. This might be a rate limit or server issue. Try again in a few minutes.'
      }
      
      alert(message)
    } finally {
      setLoading(false)
    }
  }

  async function suggestFor(movieId: string) {
    setAutoError(null)
    setAutoSuggestion(null)
    setAutoTagging(true)
    try {
      const resp = await api<{ suggestions: string[]; confidence: number; reasoning?: string }>(`/movies/${movieId}/auto-tag`, {
        method: 'POST',
        body: JSON.stringify({ provider: 'anthropic', suggestionsOnly: true })
      })
      // Ignore late responses if user navigated to a different movie
      if (currentAutoId !== movieId) return
      setAutoSuggestion(resp)
      setSelectedAutoTags(resp.suggestions || [])
    } catch (e: any) {
      setAutoError(e.message || 'Failed to get suggestions')
    } finally {
      setAutoTagging(false)
    }
  }

  // Auto-fetch suggestions whenever the target movie changes
  useEffect(() => {
    if (!autoTaggerOpen || !currentAutoId) return
    setAutoError(null)
    setAutoSuggestion(null)
    setSelectedAutoTags([])
    suggestFor(currentAutoId)
  }, [currentAutoId, autoTaggerOpen])

  async function applyFor(movie: Movie) {
    if (!autoSuggestion) return
    try {
      await api(`/movies/${movie.id}/tags`, {
        method: 'PUT',
        body: JSON.stringify({ tagSlugs: selectedAutoTags, replaceAll: false })
      })
    } catch (e) {
      console.error('Failed to save tags', e)
    }
  }

  // NOTE: Batch tagging action removed in this version

  async function exportTags() {
    try {
      const data = await api<Record<string, string[]>>('/data/export')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'rasa-tags.json'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Failed to export tags')
    }
  }

  async function importTagsFile(file: File) {
    try {
      // Close settings so the unified progress banner is visible
      setSettingsOpen(false)
      const text = await file.text()
      const map = JSON.parse(text)
      const keys = Object.keys(map || {})
      const total = keys.length
      const batchSize = 10
      let processed = 0
      let success = 0
      let fail = 0
      setImportProg({ total, processed, success, fail, running: true })
      for (let i = 0; i < keys.length; i += batchSize) {
        const chunkKeys = keys.slice(i, i + batchSize)
        const chunk: Record<string, any> = {}
        for (const k of chunkKeys) chunk[k] = map[k]
        try {
          await api('/data/import', { method: 'POST', body: JSON.stringify({ map: chunk, replaceAll: true }) })
          success += chunkKeys.length
        } catch {
          fail += chunkKeys.length
        }
        processed += chunkKeys.length
        setImportProg({ total, processed, success, fail, running: true })
      }
      setImportProg(p => p ? { ...p, running: false } : { total, processed, success, fail, running: false })
      await fetchAllMovies()
      setTimeout(() => setImportProg(null), 1500)
    } catch (e) {
      setImportProg(null)
      alert('Import failed – ensure it is a valid JSON export')
    }
  }

  async function saveOpenAIKey(key: string) {
    try {
      await api('/settings/keys', { method: 'POST', body: JSON.stringify({ anthropic_api_key: key }) })
      setShowApiKeys(false)
      alert('Anthropic API key saved successfully!')
    } catch (error) {
      console.error('Failed to save API key:', error)
      alert('Failed to save API key')
    }
  }

  const filtered = useMemo(() => {
    return movies.filter(m => (
      (!q || m.title.toLowerCase().includes(q.toLowerCase())) &&
      (!mood || (m.tags||[]).some(t => t.slug === mood))
    ))
  }, [movies, q, mood])

  const stats = useMemo(() => {
    const total = movies.length
    const tagged = movies.filter(m => (m.tags || []).length > 0).length
    const untagged = total - tagged
    return { total, tagged, untagged }
  }, [movies])

  // Untagged first, then alphabetical by title
  const ordered = useMemo(() => {
    const untagged = filtered.filter(m => (m.tags||[]).length === 0).sort((a,b)=>a.title.localeCompare(b.title))
    const tagged = filtered.filter(m => (m.tags||[]).length > 0).sort((a,b)=>a.title.localeCompare(b.title))
    return [...untagged, ...tagged]
  }, [filtered])
  
  const currentAutoMovie = useMemo(() => movies.find(m => m.id === currentAutoId) || null, [movies, currentAutoId])
  const moodCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    movies.forEach(m => (m.tags||[]).forEach(t => { counts[t.slug] = (counts[t.slug]||0)+1 }))
    return counts
  }, [movies])

  return (
    <div className="min-h-screen bg-[#f3f4f8] text-[#0f1222]">
      <div className="grid grid-cols-[72px_minmax(0,1fr)]">
        {/* Useful Sidebar */}
        <aside className="hidden sm:flex flex-col items-center gap-4 py-6 bg-white/70 backdrop-blur-xl border-r border-black/5 sticky top-0 h-screen overflow-y-auto">
          <button
            className="w-10 h-10 rounded-xl grid place-items-center bg-black text-white"
            title="Home"
          >
            🏠
          </button>
          <button
            className="w-10 h-10 rounded-xl grid place-items-center bg-black/5 hover:bg-black/10"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙️
          </button>
        </aside>
        <div>
          {/* Header */}
          <header className="sticky top-0 z-40 border-b border-black/5 backdrop-blur-xl bg-white/80">
            <div className="px-4 sm:px-8 py-6">
              <div className="flex flex-col gap-6">
                {/* Title */}
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-[28px] sm:text-[32px] font-semibold tracking-tight">
                      Dashboard
                    </h1>
                    <p className="text-black/60 mt-1 text-sm">
                      Find something to watch by mood ·{" "}
                      {ordered.length.toLocaleString()} shown ·
                      <span className="ml-1 text-emerald-700">
                        Tagged {stats.tagged}
                      </span>{" "}
                      ·
                      <span className="text-amber-700">
                        Untagged {stats.untagged}
                      </span>
                    </p>
                  </div>
                  <div className="hidden sm:flex items-center gap-3">
                    <button
                      className="px-4 py-2.5 bg-[#0f1222] hover:bg-black text-white rounded-full text-sm transition disabled:opacity-50"
                      onClick={syncAll}
                      disabled={loading}
                    >
                      {loading ? "Syncing…" : "Sync Library"}
                    </button>
                    <input
                      ref={importInputRef}
                      type="file"
                      accept="application/json"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (file) await importTagsFile(file);
                        if (e.target) e.target.value = "";
                      }}
                    />
                  </div>
                </div>

                {/* Mood chips row */}
                <div className="relative">
                  <div className="pointer-events-none absolute left-0 top-0 h-full w-8 bg-gradient-to-r from-white to-transparent" />
                  <div className="pointer-events-none absolute right-0 top-0 h-full w-8 bg-gradient-to-l from-white to-transparent" />
                  <div className="flex gap-2 overflow-x-auto no-scrollbar py-1 px-1">
                    <button
                      onClick={() => setMood("")}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs transition border shadow-sm hover:scale-[1.02] ${
                        mood === ""
                          ? "bg-gradient-to-r from-[#111827] to-[#0b1220] text-white border-transparent"
                          : "bg-white/70 backdrop-blur border-black/10 text-[#0f1222] hover:bg-white"
                      }`}
                    >
                      <span>🧺</span>
                      <span>All</span>
                    </button>
                    {Object.entries(moods).map(([slug, info]) => (
                      <button
                        key={slug}
                        onClick={() => setMood(slug)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border whitespace-nowrap transition shadow-sm hover:scale-[1.02] ${
                          mood === slug
                            ? "bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white border-transparent"
                            : "bg-white/70 backdrop-blur text-[#0f1222] border-black/10 hover:bg-white"
                        }`}
                      >
                        <span>{getMoodEmoji(slug, info.title)}</span>
                        <span>{info.title}</span>
                        <span className="ml-1 opacity-70">
                          {moodCounts[slug] || 0}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Search and quick actions */}
                <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
                  <div className="relative flex-1">
                    <svg
                      className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-black/40"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.5}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                    <input
                      className="w-full pl-12 pr-4 py-3 bg-white border border-black/10 rounded-full text-[#0f1222] placeholder-black/50 focus:outline-none focus:ring-2 focus:ring-black/10 focus:border-black/20 transition-all"
                      placeholder="Search movies..."
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                    />
                  </div>
                  <select
                    className="px-4 py-3 bg-white border border-black/10 rounded-full text-[#0f1222] focus:outline-none focus:ring-2 focus:ring-black/10 focus:border-black/20 transition-all min-w-[160px]"
                    value={mood}
                    onChange={(e) => setMood(e.target.value)}
                  >
                    <option value="">All moods</option>
                    {Object.entries(moods).map(([slug, m]) => (
                      <option key={slug} value={slug}>
                        {m.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </header>

          {/* Movies Grid */}
          <main className="px-3 sm:px-6 py-6">
            <div className="mx-auto w-full max-w-[1600px] grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))] sm:[grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
              {ordered.map((m, idx) => {
                const chips = m.tags || [];
                return (
                  <motion.div
                    key={m.id}
                    className="group"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      delay: Math.min(idx * 0.015, 0.25),
                      duration: 0.3,
                      ease: "easeOut",
                    }}
                  >
                    <motion.div
                      whileHover={{ y: -3 }}
                      className="rounded-[22px] overflow-hidden bg-white shadow-[0_18px_40px_-18px_rgba(16,24,40,0.35)] ring-1 ring-black/5"
                    >
                      <div className="relative aspect-[3/4]">
                        <img
                          className="w-full h-full object-cover"
                          src={m.posterUrl || ""}
                          alt={m.title}
                          onError={(e) => {
                            (e.target as HTMLImageElement).src =
                              "data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjMwMCIgdmlld0JveD0iMCAwIDIwMCAzMDAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMzAwIiBmaWxsPSIjRjNGNEY2Ii8+CjxwYXRoIGQ9Ik0xMDAgMTQwTDEzMCAxNjBIMTMwTDEwMCAxODBMNzAgMTYwSDcwTDEwMCAxNDBaIiBmaWxsPSIjRDFENUQ5Ii8+Cjx0ZXh0IHg9IjEwMCIgeT0iMjIwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmaWxsPSIjNjg3Mjc2IiBmb250LWZhbWlseT0ic3lzdGVtLXVpIiBmb250LXNpemU9IjE0Ij5ObyBQb3N0ZXI8L3RleHQ+Cjwvc3ZnPgo=";
                          }}
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                        {/* removed heart icon */}
                      </div>
                      {/* Details strip under image (not covering poster) */}
                      <div className="p-3 border-t border-black/5">
                        <h3
                          className="text-[14px] font-semibold leading-tight truncate"
                          title={m.title}
                        >
                          {m.title}
                        </h3>
                        {/* description removed */}
                        <div className="mt-2 flex flex-wrap gap-1.5 min-h-[22px]">
                          {chips.length === 0 ? (
                            <span className="text-[11px] text-black/40 italic">
                              No tags
                            </span>
                          ) : (
                            chips.map((t) => (
                              <span
                                key={t.slug}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] bg-black/[0.06] text-[#0f1222] border border-black/5"
                              >
                                <span>{getMoodEmoji(t.slug, t.title)}</span>
                                {t.title}
                              </span>
                            ))
                          )}
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            className="flex-1 text-[12px] font-medium py-2 rounded-full bg-[#0f1222] text-white hover:bg-black transition"
                            onClick={() => setEditingMovie(m)}
                          >
                            Edit tags
                          </button>
                          <button
                            className="hidden px-3 py-2 text-[12px] rounded-full bg-black/5"
                            onClick={() => {
                              const t = (m.tags || [])[0];
                              if (t) removeTag(m, t.slug);
                            }}
                          >
                            −
                          </button>
                          <button
                            className="hidden px-3 py-2 text-[12px] rounded-full bg-black/5"
                            onClick={() => autoTag(m)}
                          >
                            AI
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  </motion.div>
                );
              })}
            </div>

            {/* Empty State */}
            {filtered.length === 0 && !loading && (
              <div className="text-center py-20">
                <div className="mx-auto w-20 h-20 bg-black/5 rounded-full flex items-center justify-center mb-6">
                  <svg
                    className="w-8 h-8 text-black/40"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M7 4V2a1 1 0 011-1h8a1 1 0 011 1v2m0 0h4a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1h4m0-4v18m0 0H7m5 0h1"
                    />
                  </svg>
                </div>
                <h3 className="text-xl font-light text-[#0f1222] mb-2">
                  No movies found
                </h3>
                <p className="text-black/50 font-light">
                  Try adjusting your search or filters, or sync your library.
                </p>
              </div>
            )}

            {/* Loading State */}
            {loading && movies.length === 0 && (
              <div className="text-center py-20">
                <div className="mx-auto w-16 h-16 border-4 border-black/10 border-t-black rounded-full animate-spin mb-6"></div>
                <h3 className="text-xl font-light text-[#0f1222] mb-2">
                  Loading movies...
                </h3>
                <p className="text-black/50 font-light">
                  Please wait while we fetch your collection.
                </p>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Sync progress banner */}
      {syncActive && (
        <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[9999]">
          <div className="px-4 py-2 rounded-full bg-white shadow-lg border border-black/10 text-sm text-[#0f1222] flex items-center gap-2">
            <span className="inline-block w-3.5 h-3.5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
            <span>Syncing Jellyfin…</span>
          </div>
        </div>
      )}

      {importProg && (
        <div className="fixed bottom-3 left-1/2 -translate-x-1/2 z-50 w-[92%] sm:w-[640px] max-w-full rounded-2xl bg-white shadow-xl border border-black/10 p-4">
          <div className="text-sm font-medium text-[#0f1222] mb-2">
            Importing tags…
          </div>
          <div className="text-xs text-black/60 mb-2 flex gap-3">
            <span>Identified: {importProg.total}</span>
            <span>Processed: {importProg.processed}</span>
            <span>Success: {importProg.success}</span>
            <span>Failed: {importProg.fail}</span>
          </div>
          <div className="w-full h-2 rounded-full bg-black/10 overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-indigo-600 to-fuchsia-600"
              style={{
                width: `${Math.min(
                  100,
                  Math.round(
                    (importProg.processed / Math.max(1, importProg.total)) * 100
                  )
                )}%`,
              }}
            />
          </div>
          {!importProg.running && (
            <div className="mt-2 text-[11px] text-emerald-700">Completed</div>
          )}
        </div>
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full mx-4 shadow-2xl border border-black/10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Settings</h2>
              <button
                className="text-black/50 hover:text-black"
                onClick={() => setSettingsOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="space-y-6">
              <button
                className="w-full px-4 py-3 rounded-xl bg-[#0f1222] text-white hover:bg-black"
                onClick={() => {
                  setSettingsOpen(false);
                  syncAll();
                }}
                disabled={loading}
              >
                {loading ? "Syncing…" : "Sync Library"}
              </button>
              <button
                className="w-full px-4 py-3 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-white"
                onClick={() => {
                  const queue = movies
                    .filter((m) => (m.tags || []).length === 0)
                    .map((m) => m.id as string);
                  setAutoQueue(queue);
                  setAutoTagIndex(0);
                  const first = queue[0] || null;
                  setCurrentAutoId(first);
                  setAutoTaggerOpen(true);
                  setSettingsOpen(false);
                }}
              >
                AI Auto Tagger
              </button>
              <button
                className="w-full px-4 py-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white"
                onClick={async () => {
                  if (
                    !confirm(
                      "This will delete all movies from Rasa (not Jellyfin) and reset tag usage counts. Continue?"
                    )
                  )
                    return;
                  try {
                    await api("/settings/clear-movies", { method: "POST" });
                    setSettingsOpen(false);
                    await fetchAllMovies();
                  } catch (e) {
                    alert("Failed to clear movies");
                  }
                }}
              >
                Clear Local Movies
              </button>
              <button
                className="w-full px-4 py-3 rounded-xl bg-white text-[#0f1222] border border-black/10 hover:bg-gray-50"
                onClick={() => setShowApiKeys(true)}
              >
                Anthropic API Key
              </button>
              <div className="border-t border-black/10 pt-4">
                <button
                  className="w-full px-4 py-3 rounded-xl bg-black/5 hover:bg-black/10 text-[#0f1222] border border-black/10"
                  onClick={() => importInputRef.current?.click()}
                >
                  Import from JSON
                </button>
                <div className="h-2" />
                <button
                  className="w-full px-4 py-3 rounded-xl bg-black/5 hover:bg-black/10 text-[#0f1222] border border-black/10"
                  onClick={exportTags}
                >
                  Export as JSON
                </button>
                <div className="h-2" />
              </div>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) await importTagsFile(file);
                  if (e.target) e.target.value = "";
                }}
              />
              <div className="border-t border-black/10 pt-4">
                <JellyfinSetup />
              </div>
              {version && (
                <div className="pt-2 text-center text-xs text-black/50">
                  {version}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Tags Modal */}
      {editingMovie && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-3xl p-8 max-w-lg w-full mx-4 shadow-2xl border border-gray-100">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-light text-gray-900">Edit Tags</h2>
              <button
                className="text-gray-400 hover:text-gray-600 transition-colors rounded-full p-1 hover:bg-gray-100"
                onClick={() => setEditingMovie(null)}
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="mb-8">
              <h3 className="font-medium text-gray-900 mb-2">
                {editingMovie.title}
              </h3>
              <p className="text-sm text-gray-500 mb-2">
                Select up to 5 mood tags for this movie
              </p>
              <p className="text-xs text-gray-400">
                💡 Uncheck all to leave the movie untagged
              </p>
            </div>

            <EditTagsForm
              movie={editingMovie}
              availableMoods={moods}
              onSave={(selectedTags) => saveTags(editingMovie, selectedTags)}
              onCancel={() => setEditingMovie(null)}
            />
          </div>
        </div>
      )}

      {/* AI Auto Tagger Modal */}
      {autoTaggerOpen && currentAutoMovie && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-3xl p-6 max-w-4xl w-full mx-4 shadow-2xl border border-gray-100">
            <div className="flex items-start gap-6">
              <div className="w-1/3 bg-gray-100 rounded-2xl overflow-hidden">
                <img
                  src={currentAutoMovie.posterUrl || ""}
                  alt={currentAutoMovie.title}
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="flex-1">
                <div className="flex items-start justify-between mb-3">
                  <h2 className="text-xl font-light text-gray-900">
                    {currentAutoMovie.title}
                  </h2>
                  <button
                    className="text-gray-400 hover:text-gray-600 rounded-full p-1 hover:bg-gray-100"
                    onClick={() => setAutoTaggerOpen(false)}
                  >
                    <svg
                      className="w-6 h-6"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
                {/* Description intentionally not shown to keep frontend minimal */}

                <div className="rounded-xl border border-gray-200 p-4 bg-gray-50">
                  <div className="text-xs text-gray-500 mb-2">
                    AI Suggestions
                  </div>
                  {autoTagging && (
                    <div className="text-sm text-gray-600">
                      Generating suggestions…
                    </div>
                  )}
                  {autoError && (
                    <div className="text-sm text-red-600">{autoError}</div>
                  )}
                  {autoSuggestion && (
                    <div>
                      <div className="flex flex-wrap gap-2 mb-3">
                        {autoSuggestion.suggestions.map((s) => (
                          <span
                            key={s}
                            className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200"
                          >
                            {moods[s]?.title || s}
                          </span>
                        ))}
                      </div>
                      <div className="text-xs text-gray-500">
                        Confidence:{" "}
                        {(autoSuggestion.confidence * 100).toFixed(0)}%
                      </div>
                      {autoSuggestion.reasoning && (
                        <div className="text-xs text-gray-400 mt-1">
                          {autoSuggestion.reasoning}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Editable selection */}
                <div className="mt-4">
                  <div className="text-xs text-gray-500 mb-2">
                    Edit selection ({selectedAutoTags.length}/5)
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto pr-1">
                    {Object.entries(moods).map(([slug, mood]) => {
                      const isSelected = selectedAutoTags.includes(slug);
                      const disabled =
                        !isSelected && selectedAutoTags.length >= 5;
                      return (
                        <label
                          key={slug}
                          className={`flex items-center gap-3 p-3 rounded-xl border text-sm transition ${
                            isSelected
                              ? "bg-blue-50 border-blue-200"
                              : disabled
                              ? "bg-gray-50 text-gray-400 border-gray-100 cursor-not-allowed"
                              : "bg-white border-gray-200 hover:bg-gray-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={disabled}
                            onChange={() => {
                              setSelectedAutoTags((prev) => {
                                if (prev.includes(slug))
                                  return prev.filter((s) => s !== slug);
                                if (prev.length >= 5) return prev;
                                return [...prev, slug];
                              });
                            }}
                            className="w-4 h-4"
                          />
                          <span className="text-gray-800">{mood.title}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-between mt-4">
                  <div className="text-xs text-gray-400">
                    {autoTagIndex + 1} / {autoQueue.length}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full text-sm"
                      onClick={() => {
                        if (currentAutoId) {
                          setAutoSuggestion(null);
                          setSelectedAutoTags([]);
                          suggestFor(currentAutoId);
                        }
                      }}
                    >
                      Regenerate
                    </button>
                    <button
                      className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full text-sm"
                      onClick={() => {
                        // Reset edits to last AI suggestions
                        if (autoSuggestion)
                          setSelectedAutoTags(autoSuggestion.suggestions);
                      }}
                    >
                      Reset
                    </button>
                    <button
                      className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full text-sm"
                      onClick={() => {
                        // Skip
                        const next = autoTagIndex + 1;
                        if (next < autoQueue.length) {
                          setAutoTagIndex(next);
                          setAutoSuggestion(null);
                          setSelectedAutoTags([]);
                          setCurrentAutoId(autoQueue[next]);
                        } else {
                          setAutoTaggerOpen(false);
                          setCurrentAutoId(null);
                          setAutoSuggestion(null);
                          setSelectedAutoTags([]);
                        }
                      }}
                    >
                      Skip
                    </button>
                    <button
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-full text-sm disabled:opacity-50"
                      disabled={
                        !autoSuggestion || selectedAutoTags.length === 0
                      }
                      onClick={async () => {
                        if (!currentAutoMovie) return;
                        await applyFor(currentAutoMovie);
                        await fetchAllMovies();
                        const next = autoTagIndex + 1;
                        if (next < autoQueue.length) {
                          setAutoTagIndex(next);
                          setAutoSuggestion(null);
                          setSelectedAutoTags([]);
                          setCurrentAutoId(autoQueue[next]);
                        } else {
                          setAutoTaggerOpen(false);
                          setCurrentAutoId(null);
                          setAutoSuggestion(null);
                          setSelectedAutoTags([]);
                        }
                      }}
                    >
                      Apply & Next
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* API Keys Modal */}
      {showApiKeys && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-3xl p-8 max-w-md w-full mx-4 shadow-2xl border border-gray-100">
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-light text-gray-900">
                Anthropic API Key
              </h2>
              <button
                className="text-gray-400 hover:text-gray-600 transition-colors rounded-full p-1 hover:bg-gray-100"
                onClick={() => setShowApiKeys(false)}
              >
                <svg
                  className="w-6 h-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="mb-8">
              <p className="text-sm text-gray-500 mb-4 font-light">
                Enter your Anthropic API key to enable automatic movie tagging
                with AI.
              </p>
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 text-sm font-medium"
              >
                Get your API key from Anthropic →
              </a>
            </div>

            <ApiKeyForm
              onSave={saveOpenAIKey}
              onCancel={() => setShowApiKeys(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Edit Tags Form Component
function EditTagsForm({ movie, availableMoods, onSave, onCancel }: {
  movie: Movie
  availableMoods: MoodBuckets
  onSave: (selectedTags: string[]) => void
  onCancel: () => void
}) {
  const [selectedTags, setSelectedTags] = useState<string[]>(
    (movie.tags || []).map(t => t.slug)
  )
  const [filter, setFilter] = useState('')

  const handleTagToggle = (slug: string) => {
    setSelectedTags(prev => {
      if (prev.includes(slug)) {
        return prev.filter(t => t !== slug)
      } else if (prev.length < 5) {
        return [...prev, slug]
      }
      return prev
    })
  }

  return (
    <div>
      <div className="mb-4">
        <input
          className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all duration-200 font-light"
          placeholder="Search moods..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>
      <div className="space-y-3 mb-8 max-h-72 overflow-y-auto">
        {Object.entries(availableMoods).filter(([slug, mood]) => {
          const q = filter.toLowerCase()
          if (!q) return true
          return slug.toLowerCase().includes(q) || mood.title.toLowerCase().includes(q) || (mood.description||'').toLowerCase().includes(q)
        }).map(([slug, mood]) => {
          const isSelected = selectedTags.includes(slug)
          const isDisabled = !isSelected && selectedTags.length >= 5
          
          return (
            <label 
              key={slug}
              className={`flex items-center p-4 rounded-2xl border transition-all cursor-pointer ${
                isSelected 
                  ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-200/50' 
                  : isDisabled
                    ? 'bg-gray-50 border-gray-100 text-gray-400 cursor-not-allowed'
                    : 'bg-gray-50/50 border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              }`}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => handleTagToggle(slug)}
                disabled={isDisabled}
                className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 focus:ring-2 focus:ring-offset-0"
              />
              <div className="ml-4 flex-1">
                <div className="font-medium text-sm flex items-center justify-between">
                  <span className="text-gray-900">{mood.title}</span>
                  {(movie.tags || []).some(t => t.slug === slug) && !isSelected && (
                    <span className="text-xs text-red-500 font-medium px-2 py-1 bg-red-50 rounded-full">Will remove</span>
                  )}
                  {!(movie.tags || []).some(t => t.slug === slug) && isSelected && (
                    <span className="text-xs text-green-600 font-medium px-2 py-1 bg-green-50 rounded-full">Will add</span>
                  )}
                </div>
                <div className="text-xs text-gray-500 font-light mt-1">{mood.description}</div>
              </div>
            </label>
          )
        })}
      </div>
      
      <div className="flex gap-3">
        <button
          className="flex-1 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-full font-medium transition-all duration-200"
          onClick={() => onSave(selectedTags)}
        >
          {selectedTags.length === 0 ? 'Save (Untagged)' : `Save Tags (${selectedTags.length}/5)`}
        </button>
        <button
          className="px-5 py-3 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-full font-medium transition-all duration-200 text-sm"
          onClick={() => setSelectedTags([])}
          title="Remove all tags"
        >
          Clear All
        </button>
        <button
          className="px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full font-medium transition-all duration-200"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// API Key Form Component  
function ApiKeyForm({ onSave, onCancel }: {
  onSave: (key: string) => void
  onCancel: () => void
}) {
  const [apiKey, setApiKey] = useState('')

  return (
    <div>
      <div className="mb-8">
        <input
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="w-full px-4 py-4 bg-gray-50 border border-gray-200 rounded-2xl text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-all duration-200 font-light"
        />
      </div>
      
      <div className="flex gap-3">
        <button
          className="flex-1 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-full font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={() => onSave(apiKey)}
          disabled={!apiKey.trim()}
        >
          Save API Key
        </button>
        <button
          className="px-6 py-3 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-full font-medium transition-all duration-200"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// Jellyfin setup form
function JellyfinSetup() {
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [serverInfo, setServerInfo] = useState<{ serverName?: string; version?: string; localAddress?: string } | null>(null)

  async function api<T>(path: string, init?: RequestInit): Promise<T> { // shadowed local helper
    const res = await fetch('/api/v1' + path, { headers: { 'Content-Type': 'application/json' }, ...init })
    if (!res.ok) throw new Error(await res.text())
    return res.json()
  }

  // Prefill from server
  useEffect(() => {
    (async () => {
      try {
        const info = await api<{ jellyfin_url: string; jellyfin_api_key_set: boolean; jellyfin_user_id: string; anthropic_key_set: boolean }>(`/settings/info`)
        setUrl(info.jellyfin_url || '')
      } catch {}
    })()
  }, [])

  async function testConnection() {
    try {
      setTesting(true)
      const r = await api<{ success: boolean; error?: string; userId?: string; serverName?: string; version?: string; localAddress?: string }>(
        `/settings/login?save=false`, { method: 'POST', body: JSON.stringify({ jellyfin_url: url, username: apiKey, password: (document.getElementById('jf-pass') as HTMLInputElement)?.value || '' }) }
      )
      if (r.success) {
        setResult('Connection OK')
        setServerInfo({ serverName: r.serverName, version: r.version, localAddress: r.localAddress })
      } else {
        setResult(r.error || 'Connection failed')
        setServerInfo(null)
      }
    } catch (e: any) {
      setResult(e.message || 'Failed')
      setServerInfo(null)
    } finally {
      setTesting(false)
    }
  }

  async function saveConfig() {
    try {
      const password = (document.getElementById('jf-pass') as HTMLInputElement)?.value || ''
      const resp = await fetch('/api/v1/settings/login?save=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jellyfin_url: url, username: apiKey, password }) })
      const j = await resp.json()
      if (j.success) {
        setResult('Saved & authenticated')
        setServerInfo({ serverName: j.serverName, version: j.version, localAddress: j.localAddress })
      } else {
        setResult(j.error || 'Save failed')
      }
    } catch (e: any) {
      setResult(e.message || 'Save failed')
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-sm font-medium text-[#0f1222]">Jellyfin Setup</div>
      {/* removed chips */}
      <div className="grid grid-cols-1 gap-3">
        <label className="text-xs text-black/60">Jellyfin URL</label>
        <input className="px-4 py-3 rounded-2xl border border-black/10 focus:outline-none focus:ring-2 focus:ring-black/10" placeholder="http://192.168.0.111:8097" value={url} onChange={e=>setUrl(e.target.value)} />
        <label className="text-xs text-black/60">Jellyfin Username</label>
        <input className="px-4 py-3 rounded-2xl border border-black/10 focus:outline-none focus:ring-2 focus:ring-black/10" placeholder="Username" value={apiKey} onChange={e=>setApiKey(e.target.value)} />
        <label className="text-xs text-black/60">Jellyfin Password (stored password will not be shown. You can enter a new one though.)</label>
        <input id="jf-pass" className="px-4 py-3 rounded-2xl border border-black/10 focus:outline-none focus:ring-2 focus:ring-black/10" placeholder="Password" type="password" />
      </div>
      <div className="flex gap-2">
        <button className="px-4 py-2.5 rounded-xl bg-black/5 hover:bg-black/10" onClick={testConnection} disabled={testing}>{testing ? 'Testing…' : 'Test Connection'}</button>
        <button className="px-4 py-2.5 rounded-xl bg-[#0f1222] text-white hover:bg-black" onClick={saveConfig}>Save</button>
      </div>
      {result && (
        <div className="text-sm">
          <div className={result.includes('OK') ? 'text-emerald-700' : 'text-rose-700'}>{result}</div>
          {serverInfo && (
            <div className="mt-2 rounded-2xl border border-black/10 bg-black/[0.03] p-3 text-[12px] text-black/70">
              <div><span className="font-medium text-black/80">Server</span>: {serverInfo.serverName}</div>
              <div><span className="font-medium text-black/80">Version</span>: {serverInfo.version}</div>
              <div><span className="font-medium text-black/80">Address</span>: {serverInfo.localAddress}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

