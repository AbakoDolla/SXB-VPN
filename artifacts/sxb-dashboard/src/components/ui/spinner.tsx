import { cn } from '@/lib/utils';
import { Loader2Icon } from 'lucide-react';
import { useTranslation } from '../../contexts/I18nContext';

function Spinner({ className, ...props }: React.SVGProps<SVGSVGElement> & { className?: string }) {
  const { t } = useTranslation();
  return (
    <Loader2Icon
      role="status"
      aria-label={t('core.ui.loading')}
      className={cn('size-4 animate-spin', className)}
      {...(props as any)}
    />
  );
}

export { Spinner };
