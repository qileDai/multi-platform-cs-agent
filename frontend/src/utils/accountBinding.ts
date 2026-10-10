export interface BrowserProfileOption {
  id: string
  name: string
}

export function dedupeProfiles(
  workers: { browser_profiles?: BrowserProfileOption[] | null }[],
): BrowserProfileOption[] {
  const seen = new Set<string>()
  const profiles: BrowserProfileOption[] = []
  for (const worker of workers) {
    for (const item of worker.browser_profiles || []) {
      if (!item?.id || seen.has(item.id)) continue
      seen.add(item.id)
      profiles.push({ id: item.id, name: item.name || item.id })
    }
  }
  return profiles
}

export function replyBody(msgType: string, content: string): string {
  if (msgType === 'comment_reply' || msgType === 'first_comment') {
    try {
      const payload = JSON.parse(content || '')
      if (payload && typeof payload.text === 'string') return payload.text
    } catch {
      return content || ''
    }
  }
  return content || ''
}

export function rpaProfileBinding(input: {
  platform: string
  duty: string
  profile_id: string
  profile_name?: string
}) {
  return {
    platform: input.platform,
    duty: input.duty,
    adspower_profile_id: input.profile_id,
    profile_name: input.profile_name || '',
  }
}

export type FleetPresence = 'running' | 'offline' | 'missing'

const REOPEN_STATUSES = new Set([
  'login_expired', 'selector_mismatch', 'pending_login', 'browser_unavailable',
])

const DUTY_ORDER = ['dm', 'comment', 'publish']

export interface DutyBinding {
  id: number
  duty: string
  auth_status: string
  worker_status?: string
  adspower_profile_id?: string
  debug_file?: string
  account_type_mismatch?: boolean
}

export interface DutyRow {
  key: string
  accountId: number
  bindingId: number | null
  duty: string
  envLabel: string
  workerStatus: string
  authStatus: string
  debugFile: string
  accountTypeMismatch: boolean
  canReopen: boolean
  canDisable: boolean
  canEnable: boolean
  showDelete: boolean
}

export function fleetPresence(workers: { worker_id: string; status: string }[]): FleetPresence {
  const related = workers.filter((worker) => worker.status === 'fleet' || worker.worker_id.startsWith('fleet-'))
  if (related.some((worker) => worker.status === 'fleet')) return 'running'
  if (related.length === 0) return 'missing'
  return 'offline'
}

function envLabel(profileId: string, profiles: BrowserProfileOption[], fallbackName = ''): string {
  if (!profileId) return fallbackName || '—'
  return profiles.find((item) => item.id === profileId)?.name || profileId
}

export function accountDutyRows(
  accounts: { id: number; auth_type: string }[],
  overviewAccounts: { id: number; profile_name?: string; bindings?: Record<string, DutyBinding | null> }[] | undefined,
  profiles: BrowserProfileOption[],
): DutyRow[] {
  const byId = new Map((overviewAccounts || []).map((item) => [item.id, item]))
  const rows: DutyRow[] = []
  for (const account of accounts) {
    if (account.auth_type === 'api') {
      rows.push({
        key: `account-${account.id}`,
        accountId: account.id,
        bindingId: null,
        duty: '',
        envLabel: '—',
        workerStatus: '',
        authStatus: '',
        debugFile: '',
        accountTypeMismatch: false,
        canReopen: false,
        canDisable: false,
        canEnable: false,
        showDelete: true,
      })
      continue
    }
    const view = byId.get(account.id)
    const bindings = DUTY_ORDER
      .map((duty) => view?.bindings?.[duty])
      .filter((item): item is DutyBinding => Boolean(item))
    if (bindings.length === 0) {
      rows.push({
        key: `account-${account.id}-unbound`,
        accountId: account.id,
        bindingId: null,
        duty: '',
        envLabel: view?.profile_name || '—',
        workerStatus: '',
        authStatus: '',
        debugFile: '',
        accountTypeMismatch: false,
        canReopen: false,
        canDisable: false,
        canEnable: false,
        showDelete: true,
      })
      continue
    }
    bindings.forEach((binding, index) => {
      const workerStatus = binding.worker_status || ''
      const authStatus = binding.auth_status || ''
      const disabled = authStatus === 'disabled'
      rows.push({
        key: `binding-${binding.id}`,
        accountId: account.id,
        bindingId: binding.id,
        duty: binding.duty,
        envLabel: envLabel(binding.adspower_profile_id || '', profiles, view?.profile_name || ''),
        workerStatus,
        authStatus,
        debugFile: binding.debug_file || '',
        accountTypeMismatch: Boolean(binding.account_type_mismatch),
        canReopen: !disabled && (REOPEN_STATUSES.has(workerStatus) || REOPEN_STATUSES.has(authStatus)),
        canDisable: !disabled,
        canEnable: disabled,
        showDelete: index === 0,
      })
    })
  }
  return rows
}
