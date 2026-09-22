/** 全局 Toast 通知：toast.success/error/info 随处调用，右上角浮层自动消失 */
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { create } from 'zustand'

type Kind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  kind: Kind
  text: string
}

interface ToastState {
  items: ToastItem[]
  push: (kind: Kind, text: string) => void
  dismiss: (id: number) => void
}

let seq = 1

const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (kind, text) => {
    const id = seq++
    set((s) => ({ items: [...s.items.slice(-4), { id, kind, text }] })) // 最多同时 5 条
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 3200)
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

export const toast = {
  success: (text: string) => useToastStore.getState().push('success', text),
  error: (text: string) => useToastStore.getState().push('error', text),
  info: (text: string) => useToastStore.getState().push('info', text),
}

const KIND_STYLE: Record<Kind, { icon: typeof Info; cls: string }> = {
  success: { icon: CheckCircle2, cls: 'text-green-500' },
  error: { icon: XCircle, cls: 'text-red-500' },
  info: { icon: Info, cls: 'text-blue-500' },
}

export function Toaster() {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)
  return (
    <div className="fixed top-4 right-4 z-[100] space-y-2 w-72 pointer-events-none">
      {items.map((t) => {
        const Icon = KIND_STYLE[t.kind].icon
        return (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2 bg-white dark:bg-gray-800 border dark:border-gray-700 shadow-pop rounded-xl px-3.5 py-2.5 text-sm text-gray-700 dark:text-gray-200 animate-[toast-in_.2s_ease-out]"
          >
            <Icon size={16} className={`${KIND_STYLE[t.kind].cls} mt-0.5 shrink-0`} />
            <span className="flex-1 break-words">{t.text}</span>
            <button onClick={() => dismiss(t.id)} className="text-gray-300 hover:text-gray-500 shrink-0">
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
