'use client';

import { useEffect, useState } from 'react';
import Dashboard from './dashboard';

export default function DashboardShell() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), 0);
    return () => window.clearTimeout(timer);
  }, []);
  // Keep the server and first client paint identical. Saved language preferences
  // are applied by Dashboard after this neutral startup shell has mounted.
  const startupLabel = '正在打开本机控制台…';
  if (!ready) return <main className="app-shell"><div className="startup-screen"><b>円衡 Enkei</b><span>{startupLabel}</span></div></main>;
  return <Dashboard />;
}
