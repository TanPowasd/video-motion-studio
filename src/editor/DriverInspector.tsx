import React from 'react';
import type { Node } from '../core/model.js';
export function DriverInspector({
  node,
  onChange,
  onKey,
}: {
  node: Node;
  onChange: (patch: Partial<Node>) => unknown;
  onKey: (property: string) => void;
}) {
  const expressions = Object.entries(node.expressions ?? {});
  return (
    <div className="driver-controls">
      {expressions.length ? (
        expressions.map(([property, source]) => (
          <label key={property} className="driver-expression">
            <span className="mono">{property}</span>
            <textarea
              key={source}
              aria-label={`${property} 属性表达式`}
              defaultValue={source}
              rows={2}
              spellCheck={false}
              onBlur={(event) => {
                const next = event.target.value.trim(),
                  value = { ...node.expressions };
                if (next) value[property] = next;
                else delete value[property];
                if (next !== source) onChange({ expressions: value });
              }}
            />
          </label>
        ))
      ) : (
        <p className="hint">使用工程文件或外部 agent 添加属性表达式。</p>
      )}
      {node.layout && (
        <div>
          <p className="hint">
            布局基准：
            {typeof node.layout.reference === 'object'
              ? node.layout.reference.nodeId
              : node.layout.reference}{' '}
            ·{' '}
            {Object.keys(node.layout)
              .filter((key) => key !== 'reference')
              .join(' / ')}
          </p>
          <button className="secondary" onClick={() => onChange({ layout: null })}>
            解除布局约束
          </button>
        </div>
      )}
      {node.motionPath && (
        <div>
          <p className="hint">
            曲线路径：{node.motionPath.nodeId ?? 'SVG'} ·{' '}
            {node.motionPath.autoRotate ? '自动朝向' : '固定朝向'}
          </p>
          <label className="number-field">
            <span>路径进度</span>
            <input
              aria-label="路径进度"
              type="number"
              step="0.01"
              key={node.motionPath.progress}
              defaultValue={node.motionPath.progress}
              onBlur={(event) => {
                const progress = Number(event.target.value);
                if (Number.isFinite(progress))
                  onChange({ motionPath: { ...node.motionPath!, progress } });
              }}
            />
            <button title="路径进度关键帧" onClick={() => onKey('motionPath.progress')}>
              ◇
            </button>
          </label>
          <button className="secondary" onClick={() => onChange({ motionPath: null })}>
            解除路径动作
          </button>
        </div>
      )}
      {(node.layout || node.motionPath || expressions.length > 0) && (
        <p className="hint">
          驱动属性在渲染时计算；修改基值前检查依赖。解除驱动前先移除对应配置关键帧。
        </p>
      )}
    </div>
  );
}
