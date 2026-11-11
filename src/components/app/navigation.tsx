// Modified for TRACEFOLIO (2026): add career intelligence navigation.
import {
  Fingerprint,
  Building2,
  ClipboardList,
  FileText,
  FolderArchive,
  LayoutDashboard,
  Mic,
  Settings,
  Target,
  type LucideIcon,
} from "lucide-react";

import type { NavKey } from "@/lib/navigation";

export type NavItem = { key: NavKey; labelKey: NavKey; icon: LucideIcon };

export const navItems: NavItem[] = [
  { key: "intelligence", labelKey: "intelligence", icon: Fingerprint },
  { key: "dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { key: "campus", labelKey: "campus", icon: Building2 },
  { key: "resume", labelKey: "resume", icon: FileText },
  { key: "match", labelKey: "match", icon: Target },
  { key: "interview", labelKey: "interview", icon: Mic },
  { key: "library", labelKey: "library", icon: FolderArchive },
  { key: "pipeline", labelKey: "pipeline", icon: ClipboardList },
  { key: "settings", labelKey: "settings", icon: Settings },
];

export const navGroups: Array<{ labelKey: "workflow" | "system"; items: NavItem[] }> = [
  { labelKey: "workflow", items: navItems.filter((item) => item.key !== "settings") },
  { labelKey: "system", items: navItems.filter((item) => item.key === "settings") },
];
