import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import type { SchoolReferenceObservation } from '@campus/application-contracts';

type Unit = SchoolReferenceObservation['units'][number];
type Row = { unit: Unit; level: number; position: number; size: number };

@Component({
  selector: 'app-ou-reference-picker',
  imports: [MatIconModule, MatButtonModule],
  templateUrl: './ou-reference-picker.html',
  styleUrl: './ou-reference-picker.css',
})
export class OuReferencePicker {
  readonly units = input.required<Unit[]>();
  readonly selectedId = input<string | null>(null);
  readonly disabled = input(false);
  readonly selected = output<string>();
  protected readonly collapsed = signal(new Map<string, boolean>());
  private readonly activeId = signal<string | null>(null);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  protected readonly children = computed(() => {
    const children = new Map<string | null, Unit[]>();
    for (const unit of this.units()) {
      const siblings = children.get(unit.parentId) ?? [];
      siblings.push(unit);
      children.set(unit.parentId, siblings);
    }
    for (const siblings of children.values())
      siblings.sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      );
    return children;
  });
  protected readonly rows = computed(() => {
    const rows: Row[] = [];
    const seen = new Set<string>();
    const visit = (parentId: string | null, level: number) => {
      if (level > 36) return;
      const siblings = this.children().get(parentId) ?? [];
      siblings.forEach((unit, index) => {
        if (seen.has(unit.id)) return;
        seen.add(unit.id);
        rows.push({ unit, level, position: index + 1, size: siblings.length });
        if (this.expanded(unit)) visit(unit.id, level + 1);
      });
    };
    visit(null, 1);
    return rows;
  });
  protected readonly tabId = computed(() => {
    const rows = this.rows();
    return rows.some(({ unit }) => unit.id === this.activeId())
      ? this.activeId()
      : rows[0]?.unit.id;
  });

  constructor() {
    effect(() => {
      this.rows();
      untracked(() => {
        const active = this.element.nativeElement.ownerDocument.activeElement;
        if (!active || !this.element.nativeElement.contains(active)) return;
        afterNextRender(
          () => {
            const document = this.element.nativeElement.ownerDocument;
            if (document.activeElement !== document.body) return;
            const id = this.tabId();
            if (id) this.moveFocus(id);
          },
          { injector: this.injector },
        );
      });
    });
  }

  protected expanded(unit: Unit) {
    return !(this.collapsed().get(unit.id) ?? unit.parentId !== null);
  }

  protected focus(id: string) {
    this.activeId.set(id);
  }

  protected choose(id: string) {
    this.focus(id);
    if (!this.disabled()) this.selected.emit(id);
  }

  protected toggle(event: MouseEvent, unit: Unit) {
    event.stopPropagation();
    this.setExpanded(unit, !this.expanded(unit));
    this.moveFocus(unit.id);
  }

  private setExpanded(unit: Unit, expanded: boolean) {
    this.collapsed.update((current) =>
      new Map(current).set(unit.id, !expanded),
    );
  }

  private moveFocus(id: string) {
    this.focus(id);
    // Expanded children render before the next keyboard event.
    queueMicrotask(() => {
      const row = Array.from(
        this.element.nativeElement.querySelectorAll<HTMLElement>(
          '[role="treeitem"]',
        ),
      ).find((item) => item.dataset['ouId'] === id);
      row?.focus();
    });
  }

  protected key(event: KeyboardEvent, row: Row) {
    const rows = this.rows();
    const index = rows.findIndex(({ unit }) => unit.id === row.unit.id);
    let next: string | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = rows[index + 1]?.unit.id;
        break;
      case 'ArrowUp':
        next = rows[index - 1]?.unit.id;
        break;
      case 'Home':
        next = rows[0]?.unit.id;
        break;
      case 'End':
        next = rows.at(-1)?.unit.id;
        break;
      case 'ArrowRight':
        if (this.children().has(row.unit.id)) {
          if (this.expanded(row.unit)) next = rows[index + 1]?.unit.id;
          else this.setExpanded(row.unit, true);
        }
        break;
      case 'ArrowLeft':
        if (this.children().has(row.unit.id) && this.expanded(row.unit))
          this.setExpanded(row.unit, false);
        else next = row.unit.parentId ?? undefined;
        break;
      case 'Enter':
      case ' ':
        this.choose(row.unit.id);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next) this.moveFocus(next);
  }
}
