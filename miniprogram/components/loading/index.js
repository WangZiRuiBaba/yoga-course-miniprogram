'use strict';
/** 加载态：骨架条 / 转圈 */
Component({
  options: { addGlobalClass: true },
  properties: {
    text: { type: String, value: '加载中…' },
    skeleton: { type: Boolean, value: false },
    rows: { type: Number, value: 3 },
  },
  data: {},
  methods: {},
});
