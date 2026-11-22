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
      this.setData({ loading: true, error: '' });
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
                canPunch: Boolean(next),
                next: next ? next.time + ' ' + (next.kind === 'in' ? '上班' : '下班') + ' · ' + next.locationName
                  : day.remaining.length ? '有未完成打卡，请查看记录' : day.total ? '今天的打卡都已完成' : '今天暂无排班',
                places: sites.length ? '待打地点：' + sites.join('、') : day.total ? '辛苦了，今日打卡已全部记录' : '安排好班次后会在这里显示' });
            },
            fail: () => finish({ error: '连接失败，请刷新重试' })
          });
        },
        fail: () => finish({ error: '飞书免登录未完成，请重试' })
      });
}

Block({
  data: { loading: true, error: '', remaining: 0, completed: 0, total: 0, date: '', next: '', places: '', canPunch: false },
  onLoad() { loadAttendance.call(this); },
  onShow() { if (!this.lastLoaded || Date.now() - this.lastLoaded > 1000) loadAttendance.call(this); },
  onActivate() { loadAttendance.call(this); },
  onDestroy() {
    this.destroyed = true;
    if (this.requestTask) this.requestTask.abort();
    if (this.menuTap && tt.offMenuItemTap) tt.offMenuItemTap(this.menuTap);
  },
  methods: {
    refresh: loadAttendance,
    openAttendance() {
      const target = baseUrl + (this.data.canPunch ? '/#checkin' : '/#records');
      tt.openSchema({ schema: 'https://applink.feishu.cn/client/web_app/open?appId=' + encodeURIComponent(appId) + '&lk_target_url=' + encodeURIComponent(target), external: false,
        fail: () => this.setData({ error: '暂时无法打开，请从工作台打开灵活考勤' }) });
    }
  }
});
