import type {
  DiffFile,
  LiveSurfaceDiff,
  RepoInfo,
  SurfaceChange,
  SurfaceDiffReport,
} from '../types.ts';

/**
 * Computes touched CiviCRM top-level directories, static surface changes,
 * and unverified surfaces directly from the filtered diff.
 */
export function computeSurfaceDiff(diffFiles: DiffFile[], repoInfo: RepoInfo): SurfaceDiffReport {
  const changes: SurfaceChange[] = [];
  const unverifiedSurfaces = new Set<string>();
  const touchedComponents = new Set<string>();

  for (const file of diffFiles) {
    const p = file.path;
    const changeType: SurfaceChange['change'] =
      file.status === 'added' ? 'added' : file.status === 'deleted' ? 'removed' : 'modified';

    if (repoInfo.kind === 'civicrm-core') {
      const top = p.split('/')[0];
      if (
        top === 'CRM' ||
        top === 'Civi' ||
        top === 'api' ||
        top === 'templates' ||
        top === 'css' ||
        top === 'js' ||
        top === 'ang' ||
        top === 'xml'
      ) {
        touchedComponents.add(top);
      } else if (top === 'ext') {
        const extSub = p.split('/').slice(0, 2).join('/');
        if (extSub) touchedComponents.add(extSub);
      }
    } else if (repoInfo.kind === 'civicrm-extension') {
      touchedComponents.add(repoInfo.extensionName ?? 'extension');
    }

    if (file.flags.isMenuXml) {
      changes.push({
        kind: 'menu-route',
        change: changeType,
        path: p,
        detail: 'Menu route XML changed; inspect <access_arguments> and <page_callback>.',
      });
    }
    if (file.flags.isApiV4) {
      changes.push({
        kind: 'apiv4-action',
        change: changeType,
        path: p,
        detail: 'APIv4 class changed; inspect permissions() and checkPermissions usage.',
      });
    }
    if (file.flags.isSchema) {
      changes.push({
        kind: 'schema',
        change: changeType,
        path: p,
        detail: 'Schema definition changed; mounts do not run schema rebuilds.',
      });
      if (repoInfo.kind === 'civicrm-core') {
        unverifiedSurfaces.add('schema change (xml/schema) not rebuilt by container mount');
      }
    }
    if (file.flags.isUpgrade) {
      changes.push({
        kind: 'upgrade',
        change: changeType,
        path: p,
        detail: 'Upgrade handler changed; requires upgrade path verification.',
      });
      if (repoInfo.kind === 'civicrm-core') {
        unverifiedSurfaces.add('upgrade path (CRM/Upgrade/*) not verified locally by ck ab mount');
      }
    }
    if (file.flags.isManaged) {
      changes.push({
        kind: 'managed',
        change: changeType,
        path: p,
        detail: 'Managed entity definition changed.',
      });
    }
    if (file.flags.isComposer) {
      changes.push({
        kind: 'composer',
        change: changeType,
        path: p,
        detail: 'Composer dependency manifest changed; container vendor/ is unchanged.',
      });
      unverifiedSurfaces.add(
        'composer dependencies changed; composer install not executed in mounted container',
      );
    }
    if (file.flags.isSmartyTemplate || file.flags.isAfform) {
      changes.push({
        kind: 'template',
        change: changeType,
        path: p,
        detail: 'Template or Afform layout changed.',
      });
    }

    // Inspect added/removed lines for permission/hook markers
    const patch = file.rawPatch;
    if (/^[+-].*checkPermissions/m.test(patch)) {
      changes.push({
        kind: 'permission-check',
        change: 'modified',
        path: p,
        detail: 'Diff touches checkPermissions flag or permission callback.',
      });
    }
    if (/^[+-].*function\s+[a-z0-9_]+_civicrm_/im.test(patch)) {
      changes.push({
        kind: 'hook',
        change: changeType,
        path: p,
        detail: 'Diff defines or modifies a CiviCRM hook implementation.',
      });
    }
  }

  const summary =
    changes.length === 0
      ? 'No high-risk structural surface changes detected.'
      : `Detected ${changes.length} surface change(s) across [${Array.from(touchedComponents).join(', ') || 'repo'}].`;

  return {
    changes,
    unverifiedSurfaces: Array.from(unverifiedSurfaces),
    touchedComponents: Array.from(touchedComponents),
    summary,
  };
}

/**
 * Merges live `surface-diff.json` risk flags and category changes into the static SurfaceDiffReport.
 */
export function mergeLiveSurfaceDiff(
  report: SurfaceDiffReport,
  live: LiveSurfaceDiff,
): SurfaceDiffReport {
  const mergedChanges = [...report.changes];
  const unverified = new Set(report.unverifiedSurfaces);

  if (live.error) {
    unverified.add(`Live surface capture failed: ${live.error}`);
    return {
      ...report,
      unverifiedSurfaces: Array.from(unverified),
      liveSurfaceDiff: live,
    };
  }

  const categoryMap: Array<{
    key: 'api4' | 'api3' | 'routes' | 'afform';
    kind: SurfaceChange['kind'];
    label: string;
  }> = [
    { key: 'api4', kind: 'apiv4-action', label: 'APIv4' },
    { key: 'api3', kind: 'apiv4-action', label: 'APIv3' },
    { key: 'routes', kind: 'menu-route', label: 'Route' },
    { key: 'afform', kind: 'template', label: 'Afform' },
  ];

  for (const cat of categoryMap) {
    const bucket = live[cat.key];
    if (!bucket) continue;
    for (const [changeKey, changeType] of [
      ['added', 'added'],
      ['removed', 'removed'],
      ['changed', 'modified'],
    ] as const) {
      for (const item of bucket[changeKey]) {
        const target =
          cat.key === 'api4' || cat.key === 'api3'
            ? item.entity && item.action
              ? `${String(item.entity)}.${String(item.action)}`
              : String(item.name ?? item.entity ?? item.action ?? 'api')
            : String(item.name ?? item.path ?? item.route ?? item.entity ?? 'surface');
        mergedChanges.push({
          kind: cat.kind,
          change: changeType,
          path: target,
          detail: `Live ${cat.label} surface ${changeKey}: ${target}`,
        });
      }
    }
  }

  for (const flag of live.risk_flags) {
    mergedChanges.push({
      kind: 'permission-check',
      change: 'modified',
      path: flag.target,
      detail: `[${flag.severity.toUpperCase()} ${flag.code}] ${flag.reason}`,
    });
  }

  return {
    ...report,
    changes: mergedChanges,
    unverifiedSurfaces: Array.from(unverified),
    liveSurfaceDiff: live,
    summary:
      live.risk_flags.length > 0
        ? `${report.summary} Live surface diff flagged ${live.risk_flags.length} risk(s).`
        : report.summary,
  };
}
