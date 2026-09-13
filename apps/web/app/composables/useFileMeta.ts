import { FILE_INDEX_STATUS_LABEL, type FileIndexStatus, getFileKind, SECURITY_LEVEL_LABEL, type SecurityLevel } from '@kh/shared';

/**
 * 文件相关的展示映射，集中一处。
 *
 * 为什么要单独抽出来：密级名称、颜色、索引状态文案在多个页面都要用，
 * 分散写会出现「这个页面叫『部门』那个页面叫『部门级』」这种不一致。
 * 颜色也在这里定死 —— 朱红是全局唯一强调色，只给「私密」和「拦截」用。
 */
export function useFileMeta() {
  /** 密级中文名 */
  function levelLabel(lv: string): string {
    return SECURITY_LEVEL_LABEL[lv as SecurityLevel] ?? lv;
  }

  /** 密级标识色：越靠后越敏感 */
  function levelColor(lv: string): string {
    switch (lv) {
      case 'public':
        return '#98A2B3';
      case 'internal':
        return '#7A8899';
      case 'department':
        return '#2563EB';
      case 'private':
        return '#D6403A';
      default:
        return '#98A2B3';
    }
  }

  /** 索引状态中文名 */
  function indexLabel(st: string): string {
    return FILE_INDEX_STATUS_LABEL[st as FileIndexStatus] ?? st;
  }

  /** 索引状态的徽标样式 */
  function indexBadgeClass(st: string): string {
    switch (st) {
      case 'indexed':
        return 'ok';
      case 'parsing':
      case 'pending':
      case 'no_text':
        return 'warn';
      case 'failed':
        return 'err';
      default:
        return '';
    }
  }

  /** 扩展名 → 图标底色，便于在长列表里靠颜色扫读 */
  function extColor(ext: string): { bg: string; fg: string } {
    const kind = getFileKind(ext);
    switch (kind) {
      case 'doc':
        return { bg: '#FDECEA', fg: '#C0392B' };
      case 'sheet':
        return { bg: '#E8F5EC', fg: '#0F9960' };
      case 'slide':
        return { bg: '#FFF3E0', fg: '#B8801A' };
      case 'image':
        return { bg: '#F3ECFD', fg: '#6B4FBB' };
      case 'text':
        return { bg: '#EFF6FF', fg: '#2563EB' };
      case 'video':
      case 'audio':
        return { bg: '#FFF3E0', fg: '#B8801A' };
      default:
        return { bg: '#F2F4F7', fg: '#667085' };
    }
  }

  /** 可见范围的一句话描述 */
  function scopeLabel(level: string, deptIds: string[], deptName: (id: string) => string): string {
    switch (level) {
      case 'public':
      case 'internal':
        return '全公司';
      case 'department': {
        if (deptIds.length === 0) return '未指定部门';
        return deptIds.map(deptName).join('、');
      }
      case 'private':
        return '仅本人';
      default:
        return '—';
    }
  }

  return {
    levelLabel,
    levelColor,
    indexLabel,
    indexBadgeClass,
    extColor,
    scopeLabel,
  };
}
