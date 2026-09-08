import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useTranslation } from '../../contexts/I18nContext';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

export default function Pagination({
  page, pageSize, total, onPageChange, onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
}: PaginationProps) {
  const { t, formatNumber } = useTranslation();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const go = (p: number) => { if (p >= 1 && p <= totalPages) onPageChange(p); };

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-1 py-3">
      <p className="text-xs text-gray-500 shrink-0">
        {total === 0 ? t('core.pagination.empty') : t('core.pagination.range', { from: formatNumber(from), to: formatNumber(to), total: formatNumber(total) })}
      </p>
      <div className="flex items-center gap-1.5">
        {onPageSizeChange && (
          <select
            aria-label={t('core.pagination.pageSize')}
            value={pageSize}
            onChange={e => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
            className="text-xs bg-[#0a0d14] border border-[#1a1f2e] rounded-lg px-2 py-1.5 text-gray-400 focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            {pageSizeOptions.map(s => <option key={s} value={s}>{t('core.pagination.perPage', { count: formatNumber(s) })}</option>)}
          </select>
        )}
        <button aria-label={t('core.pagination.first')} onClick={() => go(1)} disabled={page <= 1}
          className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">
          <ChevronsLeft className="w-3.5 h-3.5" />
        </button>
        <button aria-label={t('core.pagination.previous')} onClick={() => go(page - 1)} disabled={page <= 1}
          className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>

        {/* Page numbers */}
        <div className="flex items-center gap-1">
          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
            let p: number;
            if (totalPages <= 5) p = i + 1;
            else if (page <= 3) p = i + 1;
            else if (page >= totalPages - 2) p = totalPages - 4 + i;
            else p = page - 2 + i;
            return (
              <button key={p} aria-label={t('core.pagination.page', { page: formatNumber(p) })} aria-current={p === page ? 'page' : undefined} onClick={() => go(p)}
                className={`w-7 h-7 text-xs rounded-lg transition-all cursor-pointer ${
                  p === page
                    ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 font-semibold'
                    : 'text-gray-500 hover:text-white hover:bg-white/5'
                }`}>
                {formatNumber(p)}
              </button>
            );
          })}
        </div>

        <button aria-label={t('core.pagination.next')} onClick={() => go(page + 1)} disabled={page >= totalPages}
          className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <button aria-label={t('core.pagination.last')} onClick={() => go(totalPages)} disabled={page >= totalPages}
          className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer">
          <ChevronsRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
