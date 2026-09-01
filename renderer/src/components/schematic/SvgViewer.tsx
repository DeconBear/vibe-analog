import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { SchematicDocumentSvg } from '../../schematic/SchematicDocumentSvg';
import { projectSchematicDocument as createSchematicDocument } from '../../schematic-core/projection/facade';
import { useKicadSymbolDefinitions } from '../../schematic/useKicadSymbolDefinitions';

export function SvgViewer() {
  const workflowSvg = useAppStore((s) => s.svgContent);
  const projectId = useAppStore((s) => s.activeProjectId);
  const moduleId = useAppStore((s) => s.activeModuleId);
  const bundle = useAppStore((s) => s.circuitProject);
  const moduleRef = bundle?.project.modules.find((module) => module.id === moduleId);
  const moduleData = moduleId ? bundle?.modules[moduleId] : undefined;
  const modulePreview = moduleId ? bundle?.module_previews[moduleId] : undefined;
  const projectContext = Boolean(projectId && moduleId && bundle);
  const symbolDefinitions = useKicadSymbolDefinitions(moduleData);
  const schematicDocument = useMemo(
    () => projectContext && moduleData ? createSchematicDocument(moduleData, { symbolDefinitions }) : null,
    [moduleData, projectContext, symbolDefinitions],
  );
  const svgContent = schematicDocument ? '' : projectContext ? modulePreview?.svg ?? '' : workflowSvg;
  const svgDimensions = useMemo(() => {
    if (schematicDocument) {
      return {
        width: schematicDocument.viewBox.maxX - schematicDocument.viewBox.minX,
        height: schematicDocument.viewBox.maxY - schematicDocument.viewBox.minY,
      };
    }
    return getSvgDimensions(svgContent);
  }, [schematicDocument, svgContent]);
  const contextLabel = projectContext
    ? `${moduleRef?.name ?? moduleId} · same module as Design and Netlist`
    : 'Workflow schematic';
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((prev) => Math.max(0.25, Math.min(4, prev + delta)));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true);
    dragStart.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
  }, [offset]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    setOffset({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  }, [dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(false);
  }, []);

  const fitView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || (!svgContent && !schematicDocument)) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const dimensions = {
      width: svgDimensions.width + SVG_FRAME_PADDING * 2,
      height: svgDimensions.height + SVG_FRAME_PADDING * 2,
    };
    const nextScale = Math.max(
      0.25,
      Math.min(4, Math.min((rect.width - 80) / dimensions.width, (rect.height - 80) / dimensions.height)),
    );
    setScale(nextScale);
    setOffset({
      x: Math.max(0, (rect.width - dimensions.width * nextScale) / 2 - 20),
      y: Math.max(0, (rect.height - dimensions.height * nextScale) / 2 - 20),
    });
  }, [schematicDocument, svgContent, svgDimensions]);

  useEffect(() => {
    fitView();
  }, [fitView]);

  const handleExport = useCallback(() => {
    const renderedDocument = viewportRef.current
      ?.querySelector('svg[data-schematic-source="document"]')
      ?.outerHTML;
    const blob = new Blob([renderedDocument || svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schematic.svg';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [svgContent]);

  if (!svgContent && !schematicDocument) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>📐</div>
        <div style={styles.emptyTitle}>No Schematic Generated</div>
        <div style={styles.emptyDesc}>
          {projectContext
            ? 'Build or save the selected module Netlist notebook to generate its matching SVG.'
            : 'Complete the rendering stage to see the workflow SVG schematic.'}
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <span style={styles.label} data-testid="svg-context-label">{contextLabel}</span>
        <div style={styles.toolGroup}>
          <button onClick={() => setScale((s) => Math.min(4, s + 0.25))} style={styles.btn}>+</button>
          <span style={styles.scaleText}>{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))} style={styles.btn}>-</button>
          <button onClick={fitView} style={styles.btn}>Fit</button>
          <button onClick={handleExport} style={styles.saveBtn}>Export SVG</button>
        </div>
      </div>
      <div
        ref={viewportRef}
        style={{ ...styles.viewport, cursor: dragging ? 'grabbing' : 'grab' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        data-testid="schematic-svg-viewport"
      >
        <div
          style={{
            ...styles.svgWrapper,
            width: svgDimensions.width,
            height: svgDimensions.height,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
          data-testid="module-netlistsvg"
          data-schematic-source={schematicDocument ? 'document' : 'netlistsvg'}
        >
          {schematicDocument ? (
            <SchematicDocumentSvg
              document={schematicDocument}
              testId="module-document-svg"
            />
          ) : (
            <div dangerouslySetInnerHTML={{ __html: sanitizeSvg(svgContent) }} />
          )}
        </div>
      </div>
    </div>
  );
}

const SVG_FRAME_PADDING = 16;

function sanitizeSvg(svg: string): string {
  // Remove script tags and event handlers for safety
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s(?:href|xlink:href)\s*=\s*["']\s*javascript:[^"']*["']/gi, '');
}

function parseSvgLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getSvgDimensions(svg: string): { width: number; height: number } {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = doc.documentElement;
    const viewBox = root.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
    const width = viewBox?.[2];
    const height = viewBox?.[3];
    if (
      viewBox?.length === 4 &&
      typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0
    ) {
      return { width, height };
    }
    return {
      width: parseSvgLength(root.getAttribute('width')) ?? 800,
      height: parseSvgLength(root.getAttribute('height')) ?? 600,
    };
  } catch {
    return { width: 800, height: 600 };
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: 'flex', flexDirection: 'column', height: '100%' },
  toolbar: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '6px 16px',
    backgroundColor: '#ffffff',
    borderBottom: '1px solid #dfe3e8',
  },
  label: { fontSize: 12, color: '#4f5965', fontWeight: 650 },
  toolGroup: { display: 'flex', alignItems: 'center', gap: 6 },
  btn: {
    background: '#ffffff',
    color: '#3f4a56',
    border: '1px solid #c7ced6',
    borderRadius: 4,
    padding: '2px 10px',
    cursor: 'pointer',
    fontSize: 14,
  },
  scaleText: { fontSize: 12, color: '#69727d', minWidth: 44, textAlign: 'center' },
  saveBtn: {
    padding: '4px 14px',
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    marginLeft: 8,
  },
  viewport: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#f2f4f7',
    position: 'relative',
  },
  svgWrapper: {
    position: 'absolute',
    left: 20,
    top: 20,
    backgroundColor: '#ffffff',
    borderRadius: 4,
    border: '1px solid #dfe3e8',
    boxShadow: '0 4px 20px rgba(32, 42, 56, 0.12)',
    padding: SVG_FRAME_PADDING,
    boxSizing: 'content-box',
  },
  empty: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#7b8490',
    gap: 8,
  },
  emptyIcon: { fontSize: 40, opacity: 0.4 },
  emptyTitle: { fontSize: 16, fontWeight: 600, color: '#303741' },
  emptyDesc: { fontSize: 13, color: '#7b8490', textAlign: 'center', lineHeight: 1.6, maxWidth: 520 },
};
