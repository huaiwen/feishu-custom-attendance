const { baseUrl, appId } = require('./config');

function loadAttendance() {
      if (this.busy || this.destroyed) return;
      if (!this.menuTap && tt.onMenuItemTap) {
        this.menuTap = event => {
          // The official table and example describe nested and flat menu items.
          if ((event.menuItem || event).key === 'refresh') loadAttendance.call(this);
        };
        tt.onMenuItemTap(this.menuTap);
      }
      this.busy = true;
      this.setData({ loading: true, error: '', errorDetail: '' });
      const finish = patch => {
        this.busy = false;
        if (!this.destroyed) this.setData(Object.assign({ loading: false }, patch));
      };
      tt.login({
        success: login => {
          if (this.destroyed) return;
          if (!login.code) return finish({ error: '免登录未完成，请重试' });
          this.requestTask = tt.request({
            url: baseUrl + '/api/widget/today', method: 'POST',
            header: { 'content-type': 'application/json' }, data: { code: login.code }, dataType: 'json',
            success: response => {
              const day = response.data;
              if (response.statusCode !== 200 || !day || !Array.isArray(day.remaining)) return finish({ error: day && day.error || '暂时无法读取，请重试' });
              const next = day.remaining.find(p => !p.expired);
              const sites = [];
              day.remaining.forEach(p => { if (sites.indexOf(p.locationName) === -1) sites.push(p.locationName); });
              this.lastLoaded = Date.now();
              finish({ date: day.date, remaining: day.remaining.length, completed: day.completed, total: day.total,
                leadGroup: day.leadership?.groupName || '',
                leadRole: day.leadership?.groupCount > 1 ? '考勤组长 · 共 ' + day.leadership.groupCount + ' 组' : '考勤组长',
                punches: (day.punches || day.remaining).slice(0, 2).map(p => ({
                  label: p.time + ' ' + (p.kind === 'in' ? '上班' : '下班') + ' · ' + p.locationName,
                  status: p.done ? '已打卡' : p.expired ? '未完成' : '待打卡'
                })),
                canPunch: Boolean(next),
                next: next ? next.time + ' ' + (next.kind === 'in' ? '上班' : '下班') + ' · ' + next.locationName
                  : day.remaining.length ? '有未完成打卡，请查看记录' : day.total ? '今天的打卡都已完成' : '今天暂无排班',
                places: sites.length ? '待打地点：' + sites.join('、') : day.total ? '辛苦了，今日打卡已全部记录' : '安排好班次后会在这里显示' });
            },
            fail: (error = {}) => {
              // Never display request URLs or credentials in SDK diagnostics.
              const codes = [error.errno, error.errCode].filter(code => /^-?\d{1,10}$/.test(String(code)));
              const networkCode = String(error.errMsg || '').match(/internal_code=(-?\d{1,10})\b/);
              if (networkCode) codes.push(networkCode[1]);
              const detail = String(error.errString || error.errMsg || '飞书未返回原因')
                .replace(/https?:\/\/\S+/g, '[服务器地址]')
                .replace(/\b(code|token|secret|cookie|authorization)\s*[:=]\s*\S+/gi, '$1=[已隐藏]')
                .replace(/[A-Za-z0-9_-]{24,}/g, '[已隐藏]').slice(0, 120);
              finish({ error: '连接失败' + (codes.length ? '（' + codes.join('/') + '）' : ''), errorDetail: detail });
            }
          });
        },
        fail: () => finish({ error: '飞书免登录未完成，请重试' })
      });
}

Block({
  data: { loading: true, error: '', errorDetail: '', remaining: 0, completed: 0, total: 0, date: '', next: '', places: '', leadGroup: '', leadRole: '', canPunch: false, expanded: false, punches: [] },
  onLoad() { loadAttendance.call(this); },
  onReady() {
    this.resize = ({ height }) => { if (!this.destroyed) this.setData({ expanded: height >= 240 }); };
    if (tt.getContainerRect) tt.getContainerRect({ success: this.resize });
    if (tt.onContainerResize) tt.onContainerResize(this.resize);
  },
  onShow() { if (!this.lastLoaded || Date.now() - this.lastLoaded > 1000) loadAttendance.call(this); },
  onActivate() { loadAttendance.call(this); },
  onDestroy() {
    this.destroyed = true;
    if (this.requestTask) this.requestTask.abort();
    if (this.menuTap && tt.offMenuItemTap) tt.offMenuItemTap(this.menuTap);
    if (this.resize && tt.offContainerResize) tt.offContainerResize(this.resize);
  },
  methods: {
    refresh: loadAttendance,
    openRecords() {
      tt.openSchema({ schema: 'https://applink.feishu.cn/client/web_app/open?appId=' + encodeURIComponent(appId) + '&lk_target_url=' + encodeURIComponent(baseUrl + '/#records'), external: false,
        fail: () => this.setData({ error: '暂时无法打开，请从工作台打开灵活考勤' }) });
    },
    openAttendance() {
      const target = baseUrl + (this.data.canPunch ? '/#checkin' : '/#records');
      tt.openSchema({ schema: 'https://applink.feishu.cn/client/web_app/open?appId=' + encodeURIComponent(appId) + '&lk_target_url=' + encodeURIComponent(target), external: false,
        fail: () => this.setData({ error: '暂时无法打开，请从工作台打开灵活考勤' }) });
    }
  }
});
