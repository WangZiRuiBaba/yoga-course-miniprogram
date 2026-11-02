'use strict';
/** 空态：可带「重试」按钮 */
Component({
  options: { addGlobalClass: true },
  properties: {
    icon: { type: String, value: '🧘' },
    text: { type: String, value: '这里还什么都没有' },
    tip: { type: String, value: '' },
    showRetry: { type: Boolean, value: false },
    retryText: { type: String, value: '重新加载' },
    compact: { type: Boolean, value: false },
  },
  data: {},
  methods: {
    onRetry() {
      this.triggerEvent('retry');
    },
  },
});
