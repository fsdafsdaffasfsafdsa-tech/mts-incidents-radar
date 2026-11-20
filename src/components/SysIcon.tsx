import { Package } from 'lucide-react';

/** Значок продукта. В выгрузке иконок нет — у всех продуктов один нейтральный знак. */
export function SysIcon({ size = 16 }: { systemId?: string; size?: number }) {
  return <Package size={size} strokeWidth={1.9} aria-hidden />;
}
