const { createLocationSharing } = require('../../services/location-sharing');
const { createTracker } = require('../../services/location-tracker');

const INVITE_VALUE = /^[a-f0-9]{32}$/i;
const DEFAULT_CENTER = { latitude: 22.543096, longitude: 114.057865 };

function validLocation(point) {
  return point && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 &&
    Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

function ageText(location, serverTime) {
  const seconds = Math.max(0, Math.floor((serverTime - location.updatedAt) / 1000));
  return seconds < 5 ? '刚刚更新' : `${seconds} 秒前更新`;
}

Page({
  data: {
    configured: false,
    inviteValid: false,
    joined: false,
    busy: false,
    ownBusy: false,
    sharing: false,
    pendingStop: false,
    gpsStopFailed: false,
    isOwner: false,
    canInvite: false,
    canOpenSettings: false,
    phase: 'idle',
    statusLabel: '等待加入',
    pageError: '',
    gpsError: '',
    gpsHint: '你尚未共享自己的位置',
    expiresText: '',
    members: [],
    markers: [],
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    scale: 15
  },

  onLoad(query = {}) {
    this._disposed = false;
    this._hidden = false;
    this._shareGeneration = 0;
    this._acceptGps = false;
    this._invite = INVITE_VALUE.test(query.roomId || '') && INVITE_VALUE.test(query.inviteToken || '') ? {
      roomId: query.roomId,
      inviteToken: query.inviteToken
    } : null;
    this._sharing = createLocationSharing({ onChange: (snapshot) => this.applySharingSnapshot(snapshot) });
    this._tracker = createTracker({ onChange: (snapshot) => this.applyGpsSnapshot(snapshot) });
    this.setData({ inviteValid: !!this._invite });
    this.applySharingSnapshot(this._sharing.snapshot());
  },

  applySharingSnapshot(snapshot) {
    if (this._disposed || !snapshot) return;
    this._shareSnapshot = snapshot;
    const room = snapshot.room;
    const terminal = snapshot.phase === 'closed' || snapshot.phase === 'expired';
    const joined = !!room && room.status === 'active' && !terminal;
    const serverTime = room && Number.isFinite(room.serverTime) ? room.serverTime : Date.now();
    const members = joined ? (room.members || []).map((member) => {
      const location = member.live && validLocation(member.location) ? member.location : null;
      return {
        id: member.id,
        label: member.id === room.selfId ? '我' : member.label || '共享成员',
        role: member.role,
        isSelf: member.id === room.selfId,
        live: !!location,
        location,
        stateText: location ? ageText(location, serverTime) : member.sharing ? '等待有效定位' : '已暂停共享'
      };
    }) : [];
    const markers = members.filter((member) => member.location).map((member, index) => ({
      id: index + 1,
      latitude: member.location.latitude,
      longitude: member.location.longitude,
      title: member.label,
      iconPath: member.isSelf ? '/assets/tabbar/profile-active.png' : '/assets/tabbar/home-active.png',
      width: 30,
      height: 30,
      anchor: { x: 0.5, y: 0.5 },
      callout: { content: member.label, display: 'ALWAYS', fontSize: 13, color: '#24533e', bgColor: '#ffffff', borderRadius: 8, padding: 8 }
    }));
    const remainingSeconds = room ? Math.max(0, Math.ceil((room.expiresAt - serverTime) / 1000)) : 0;
    const patch = {
      configured: !!snapshot.configured,
      joined,
      busy: !!snapshot.busyAction,
      sharing: !!snapshot.sharing,
      pendingStop: !!snapshot.pendingStop,
      phase: snapshot.phase,
      pageError: snapshot.errorMessage || '',
      statusLabel: terminal ? (snapshot.phase === 'expired' ? '本次共享已过期' : '本次共享已结束') : joined ? '共享地图已连接' : '等待加入',
      isOwner: !!room && room.selfId === room.ownerId,
      canInvite: joined && !!this._sharing.invitePath(),
      expiresText: joined ? `剩余 ${Math.floor(remainingSeconds / 60)} 分 ${remainingSeconds % 60} 秒` : '',
      members,
      markers
    };
    if (!this._hasCentered && markers.length) {
      const ownIndex = members.filter((member) => member.location).findIndex((member) => member.isSelf);
      const first = markers[ownIndex >= 0 ? ownIndex : 0];
      patch.latitude = first.latitude;
      patch.longitude = first.longitude;
      this._hasCentered = true;
    }
    this.setData(patch);
    if ((terminal || !snapshot.sharing) && this._acceptGps) {
      this._acceptGps = false;
      this._shareGeneration += 1;
      this.setData({ ownBusy: false, gpsHint: terminal ? '本次共享已结束，位置监听已暂停' : '自己的位置共享已暂停' });
      this._tracker.pause(terminal ? '本次位置共享已结束' : '自己的位置共享已暂停');
    }
  },

  applyGpsSnapshot(snapshot) {
    if (this._disposed || !snapshot) return;
    const hint = snapshot.status === 'starting' ? '正在申请定位并开启位置更新' :
      snapshot.status === 'recording' ? (snapshot.waitingForLocation ? '正在等待有效定位，请到开阔处稍候' : '正在共享自己的最新位置') : '你尚未共享自己的位置';
    this.setData({
      gpsError: snapshot.errorMessage || '',
      gpsHint: hint,
      gpsStopFailed: !!snapshot.nativeStopFailed,
      canOpenSettings: /AUTH|PERMISSION/.test(snapshot.errorCode || '')
    });
    if (this._acceptGps && snapshot.status === 'recording' && !snapshot.waitingForLocation && validLocation(snapshot.currentLocation)) {
      this._sharing.updateLocation(snapshot.currentLocation);
    } else if (this._acceptGps && (snapshot.status === 'paused' || snapshot.status === 'finished')) {
      this._acceptGps = false;
      this._sharing.pausePublishing();
    }
  },

  async onJoinRoom() {
    if (!this._invite || this.data.busy || this._disposed || this._hidden) return;
    this.applySharingSnapshot(await this._sharing.join(this._invite));
  },

  async onStartOwnSharing() {
    if (!this.data.joined || this.data.ownBusy || this.data.sharing || this._disposed || this._hidden) return;
    const generation = ++this._shareGeneration;
    this.setData({ ownBusy: true, gpsError: '' });
    try {
      const shared = await this._sharing.startPublishing();
      if (this._disposed || this._hidden || generation !== this._shareGeneration) return;
      this.applySharingSnapshot(shared);
      if (!shared.sharing) return;
      this._acceptGps = true;
      const current = this._tracker.snapshot();
      const position = await (current.status === 'paused' ? this._tracker.resume() : this._tracker.start());
      if (this._disposed || this._hidden || generation !== this._shareGeneration) return;
      this.applyGpsSnapshot(position);
      if (position.status !== 'recording' && this._acceptGps) {
        this._acceptGps = false;
        this.applySharingSnapshot(await this._sharing.pausePublishing());
      }
    } catch (error) {
      this._acceptGps = false;
      if (!this._disposed) this.setData({ gpsError: '暂时无法开启位置共享，请重试' });
      await this._sharing.pausePublishing();
    } finally {
      if (!this._disposed && generation === this._shareGeneration) this.setData({ ownBusy: false });
    }
  },

  async onStopOwnSharing() {
    if (this._disposed) return;
    this._shareGeneration += 1;
    this._acceptGps = false;
    this.setData({ ownBusy: false });
    const results = await Promise.all([this._tracker.pause(), this._sharing.pausePublishing()]);
    if (!this._disposed) {
      this.applyGpsSnapshot(results[0]);
      this.applySharingSnapshot(results[1]);
    }
  },

  async onLeaveRoom() {
    if (this.data.busy || this._disposed) return;
    this._shareGeneration += 1;
    this._acceptGps = false;
    this.setData({ ownBusy: false });
    const results = await Promise.all([this._tracker.pause(), this._sharing.leave()]);
    if (this._disposed) return;
    this.applyGpsSnapshot(results[0]);
    this.applySharingSnapshot(results[1]);
    if (!results[1].room && !results[1].pendingStop && !results[0].nativeStopFailed) wx.switchTab({ url: '/pages/home/index' });
  },

  onCloseRoom() {
    if (!this.data.isOwner || this.data.busy) return;
    wx.showModal({
      title: '结束本次位置共享？',
      content: '结束后，所有成员的位置都会从本次共享地图中撤回。',
      confirmText: '结束共享',
      confirmColor: '#07a66a',
      success: (result) => {
        if (!this._disposed && result.confirm) this.closeRoom();
      }
    });
  },

  async closeRoom() {
    if (this._disposed) return;
    this._shareGeneration += 1;
    this._acceptGps = false;
    this.setData({ ownBusy: false });
    const results = await Promise.all([this._tracker.pause(), this._sharing.close()]);
    if (!this._disposed) {
      this.applyGpsSnapshot(results[0]);
      this.applySharingSnapshot(results[1]);
    }
  },

  onRecenter() {
    const own = this.data.members.find((member) => member.isSelf && member.location);
    const point = own && own.location || this.data.markers[0];
    if (!point) return;
    this.setData({ latitude: point.latitude, longitude: point.longitude });
    try {
      const context = wx.createMapContext('shared-location-map', this);
      context.moveToLocation({ latitude: point.latitude, longitude: point.longitude });
    } catch (error) {
      wx.showToast({ title: '暂时无法调整地图，请拖动查看', icon: 'none' });
    }
  },

  onOpenLocationSettings() {
    wx.openSetting({ success: () => wx.showToast({ title: '设置完成后重新开启共享', icon: 'none' }) });
  },

  onBackHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },

  onShareAppMessage(options = {}) {
    const explicit = options.from === 'button' && options.target && options.target.id === 'invite-friend';
    const path = explicit && this._sharing && this._sharing.invitePath();
    return path ? { title: '邀请你加入我的位置共享地图', path, imageUrl: '/assets/share/location-invite.png' } : {
      title: '起点 Seed · 一起记录运动', path: '/pages/home/index', imageUrl: '/assets/share/location-invite.png'
    };
  },

  onShow() {
    this._hidden = false;
    if (this._sharing && this.data.joined) this._sharing.resumePolling();
  },

  onHide() {
    this._hidden = true;
    this._shareGeneration += 1;
    this._acceptGps = false;
    this.setData({ ownBusy: false });
    const position = this._tracker.snapshot();
    const pause = position.status === 'recording' || position.status === 'starting' || position.nativeStopFailed ?
      this._tracker.pause('离开页面后，位置共享已暂停') : Promise.resolve(position);
    return Promise.all([pause, this._sharing.suspend()]);
  },

  onUnload() {
    this._disposed = true;
    this._shareGeneration += 1;
    this._acceptGps = false;
    return Promise.all([this._tracker.destroy(), this._sharing.destroy()]);
  }
});
