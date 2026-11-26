import { PDFArray, PDFDict, PDFName, PDFRawStream, type PDFContext, type PDFObject } from "pdf-lib";
import { dictionaryEntry } from "./objects";

type ResourceNode = PDFDict | PDFRawStream;
type Edge = { container: ResourceNode; key: PDFName };
const key = PDFName.of;

function add<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const edges = map.get(key) ?? [];
  edges.push(value);
  map.set(key, edges);
}

function referencedBy(nodes: Iterable<ResourceNode>, incoming: Map<ResourceNode, Edge[]>): Set<ResourceNode> {
  const reached = new Set(nodes);
  for (const node of reached) {
    for (const { container } of incoming.get(node) ?? []) reached.add(container);
  }
  return reached;
}

/** A dead alias can keep old samples reachable through a Form that itself has
 * no paint use. Follow XObject and Form Resources edges, then copy only the
 * dictionaries and streams that lead to a removed binding. */
export function dropUnusedImageBindings(
  root: PDFDict,
  live: Map<PDFDict, Set<PDFName>>,
  obsolete: Set<PDFRawStream>,
): PDFDict {
  if (!obsolete.size) return root;
  const ctx = root.context;
  const incoming = new Map<ResourceNode, Edge[]>();
  const groups = new Set<PDFDict>();
  const pending = new Set<ResourceNode>([root]);
  const connect = (container: ResourceNode, attribute: PDFName, value: ResourceNode) => {
    add(incoming, value, { container, key: attribute });
    pending.add(value);
  };
  const connectDict = (container: ResourceNode, dict: PDFDict, name: string) => {
    const entry = dictionaryEntry(dict, name);
    const value = ctx.lookup(entry);
    if (value instanceof PDFDict) connect(container, key(name), value);
    return value;
  };
  function visitResources(resources: PDFDict) {
    const objects = connectDict(resources, resources, "XObject");
    if (objects instanceof PDFDict) groups.add(objects);
  }
  function visitForm(form: PDFRawStream) {
    // A resource-less Form resolves XObjects through its invocation scope.
    // The walk already records those uses against the associated dictionary.
    if (form.dict.lookup(key("Subtype")) === key("Form")) connectDict(form, form.dict, "Resources");
  }
  for (const node of pending) {
    if (node instanceof PDFRawStream) visitForm(node);
    else if (groups.has(node)) {
      for (const [name, entry] of node.entries()) {
        const value = ctx.lookup(entry);
        if (value instanceof PDFRawStream) connect(node, name, value);
      }
    } else visitResources(node);
  }

  const reachesObsolete = referencedBy(obsolete, incoming);
  const removed = new Map<ResourceNode, Set<PDFName>>();
  for (const value of reachesObsolete) {
    for (const edge of incoming.get(value) ?? []) {
      const { container, key } = edge;
      if (!(container instanceof PDFDict)) continue;
      const uses = live.get(container);
      if (!uses || uses.has(key)) continue;
      const names = removed.get(container) ?? new Set();
      names.add(key);
      removed.set(container, names);
    }
  }

  const changed = referencedBy(removed.keys(), incoming);
  if (!changed.has(root)) return root;
  return projectResources(ctx, root, changed, incoming, removed);
}

function projectResources(
  ctx: PDFContext,
  root: PDFDict,
  changed: Set<ResourceNode>,
  incoming: Map<ResourceNode, Edge[]>,
  removed: Map<ResourceNode, Set<PDFName>>,
): PDFDict {
  const copies = new Map([...changed].map(node =>
    [node, node instanceof PDFRawStream ? PDFRawStream.of(node.dict.clone(), node.getContents()) : node.clone()],
  ));
  const refs = new Map<PDFRawStream, ReturnType<PDFContext["register"]>>();
  for (const [old, copy] of copies) {
    if (old instanceof PDFRawStream) refs.set(old, ctx.register(copy));
  }
  for (const [node, names] of removed) {
    const copy = copies.get(node) as PDFDict;
    for (const name of names) copy.delete(name);
  }
  for (const [value, copy] of copies) {
    for (const { container, key } of incoming.get(value) ?? []) {
      const parent = copies.get(container);
      if (!parent || removed.get(container)?.has(key)) continue;
      const dict = parent instanceof PDFRawStream ? parent.dict : parent;
      dict.set(key, value instanceof PDFRawStream ? refs.get(value)! : copy);
    }
  }
  return copies.get(root) as PDFDict;
}


/** Confirm that a replaced image is reachable only if another paint needs it. */
export function verifyReplacedImages(
  page: PDFDict, live: Map<PDFDict, Set<PDFName>>, replaced: Set<PDFRawStream>,
): void {
  if (!replaced.size) return;
  const paintedImages = new Set<PDFRawStream>();
  for (const [group, names] of live) {
    for (const name of names) {
      const stream = group.lookup(name);
      if (stream instanceof PDFRawStream && stream.dict.lookup(key("Subtype")) === key("Image")) paintedImages.add(stream);
    }
  }
  // Masks and alternate image streams may have no Do of their own.
  for (const stream of paintedImages) {
    replaced.delete(stream);
    for (const attribute of ["SMask", "Mask"]) {
      const mask = stream.dict.lookup(key(attribute));
      if (mask instanceof PDFRawStream) paintedImages.add(mask);
    }
    const alternates = stream.dict.lookup(key("Alternates"));
    if (alternates instanceof PDFArray) {
      for (let i = 0; i < alternates.size(); i += 1) {
        const alternate = alternates.lookup(i);
        const image = alternate instanceof PDFDict && alternate.lookup(key("Image"));
        if (image instanceof PDFRawStream) paintedImages.add(image);
      }
    }
  }
  if (!replaced.size) return;

  const seen = new Set<PDFObject>([page]);
  const visit = (object: PDFObject | undefined) => {
    const value = page.context.lookup(object);
    if (value) seen.add(value);
  };
  for (const object of seen) {
    if (object instanceof PDFRawStream) {
      if (replaced.has(object)) throw Error("cannot remove all unused references to the replaced Image XObject");
      seen.add(object.dict);
    } else if (object instanceof PDFArray) {
      for (const entry of object.asArray()) visit(entry);
    } else if (object instanceof PDFDict) {
      const type = object.lookup(key("Type"));
      if (object !== page && (type === key("Page") || type === key("Pages"))) continue;
      for (const [name, entry] of object.entries()) if (name !== key("Parent")) visit(entry);
    }
  }
}
