/** Promise 式对话框：confirmDialog / promptDialog，替代 window.confirm / window.prompt */
import { FormEvent, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  danger?: boolean
}

interface PromptOptions {
  title: string
  placeholder?: string
  defaultValue?: string
  confirmText?: string
}

type DialogReq =
  | ({ kind: 'confirm'; resolve: (v: boolean) => void } & ConfirmOptions)
  | ({ kind: 'prompt'; resolve: (v: string | null) => void } & PromptOptions)

interface DialogState {
  current: DialogReq | null
  open: (req: DialogReq) => void
  close: () => void
}

const useDialogStore = create<DialogState>((set) => ({
  current: null,
  open: (req) => set({ current: req }),
  close: () => set({ current: null }),
}))

/** 确认对话框：返回 Promise<boolean>（danger=true 时确认键为红色） */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => useDialogStore.getState().open({ kind: 'confirm', ...opts, resolve }))
}

/** 输入对话框：返回 Promise<string | null>（取消为 null） */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => useDialogStore.getState().open({ kind: 'prompt', ...opts, resolve }))
}

export function DialogHost() {
  const current = useDialogStore((s) => s.current)
  const close = useDialogStore((s) => s.close)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (current?.kind === 'prompt') {
      setValue(current.defaultValue || '')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [current])

  if (!current) return null

  const done = (v: boolean | string | null) => {
    current.resolve(v as never)
    close()
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    done(current.kind === 'prompt' ? value : true)
  }

  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center" onClick={() => done(current.kind === 'prompt' ? null : false)}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-pop w-[360px] p-5"
      >
        <div className="text-sm font-medium text-gray-800 dark:text-gray-100">{current.title}</div>
        {current.kind === 'confirm' && current.message && (
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-2 leading-relaxed">{current.message}</div>
        )}
        {current.kind === 'prompt' && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={current.placeholder}
            className="w-full border dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded-lg px-3 py-2 text-sm mt-3 outline-none focus:border-blue-500"
          />
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={() => done(current.kind === 'prompt' ? null : false)}
            className="text-xs px-4 py-2 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            取消
          </button>
          <button
            type="submit"
            className={`text-xs px-4 py-2 rounded-lg text-white font-medium ${
              current.kind === 'confirm' && current.danger
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-blue-600 hover:bg-blue-700'
            }`}
          >
            {current.confirmText || '确认'}
          </button>
        </div>
      </form>
    </div>
  )
}
