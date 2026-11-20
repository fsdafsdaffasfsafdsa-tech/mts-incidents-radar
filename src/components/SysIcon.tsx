import {
  Clapperboard,
  CreditCard,
  Headset,
  MessageSquareText,
  MonitorSmartphone,
  Network,
  RadioTower,
  Receipt,
  Router,
  Server,
  Smartphone,
  Workflow,
  CircleDot,
  type LucideIcon,
} from 'lucide-react';
import { useStore } from '../store';

const ICONS: Record<string, LucideIcon> = {
  Receipt,
  RadioTower,
  Network,
  Smartphone,
  MonitorSmartphone,
  CreditCard,
  Server,
  Workflow,
  Clapperboard,
  Router,
  Headset,
  MessageSquareText,
};

export function SysIcon({ systemId, size = 16 }: { systemId: string; size?: number }) {
  const icon = useStore((s) => s.systems.find((x) => x.id === systemId)?.icon);
  const Cmp = (icon && ICONS[icon]) || CircleDot;
  return <Cmp size={size} strokeWidth={1.9} aria-hidden />;
}
