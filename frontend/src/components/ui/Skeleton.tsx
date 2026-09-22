/** 骨架屏：列表/卡片加载占位 */
interface Props {
  rows?: number
  className?: string
}

export default function Skeleton({ rows = 3, className = '' }: Props) {
  return (
    <div className={`animate-pulse space-y-3 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-2/5" />
            <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}
