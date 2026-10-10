import type { Node } from "web-tree-sitter";
import { detectLanguage } from "../languages.js";
import { withSyntaxTree } from "../treesitter.js";
import { WEIGHT, type FileExtraction, type SymbolType, type RelationType, type ExtractedImport } from "./types.js";

const GRAMMARS: Record<string, string> = {
  typescript: "typescript", javascript: "javascript", python: "python", java: "java",
  go: "go", rust: "rust", php: "php", csharp: "c_sharp", cpp: "cpp",
  c: "c", ruby: "ruby", html: "html", vue: "vue",
};

const CLASSES = new Set([
  "class_declaration", "class_definition", "class_specifier", "class_statement", "struct_item",
  "struct_specifier", "interface_declaration", "interface_specifier", "trait_item",
]);
const FUNCTIONS = new Set([
  "function_declaration", "function_definition", "function_item", "function_statement",
  "method_declaration", "method_definition", "method", "constructor_declaration", "singleton_method",
]);
const CALLS = new Set([
  "call_expression", "call", "method_invocation", "invocation_expression", "function_call_expression",
  "method_call", "command", "command_call",
]);
const IMPORTS = new Set([
  "import_statement", "import_declaration", "import_from_statement", "import_spec",
  "use_declaration", "use_item", "preproc_include", "include_expression",
]);
const IDENTIFIERS = new Set([
  "identifier", "type_identifier", "property_identifier", "field_identifier", "name",
  "constant", "package_identifier", "qualified_identifier", "scoped_identifier",
]);

export function grammarForPath(relPath: string): string | null {
  if (relPath.endsWith(".tsx")) return "tsx";
  if (relPath.endsWith(".vue")) return "vue";
  if (relPath.endsWith(".jsx")) return "javascript";
  return GRAMMARS[detectLanguage(relPath)] ?? null;
}

function children(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}

function identifier(node: Node | null): string | null {
  if (!node) return null;
  if (IDENTIFIERS.has(node.type)) return node.text;
  for (const child of children(node)) {
    const name = identifier(child);
    if (name) return name;
  }
  return null;
}

function nameOf(node: Node): string | null {
  return identifier(node.childForFieldName("name") ?? node.childForFieldName("declarator")) ??
    children(node).map(identifier).find((name) => name !== null) ?? null;
}

function textOf(node: Node): string {
  return node.text.trim().split("\n")[0].slice(0, 120);
}

function lineEnd(node: Node): number {
  return Math.max(node.startPosition.row + 1, node.endPosition.row + (node.endPosition.column > 0 ? 1 : 0));
}

function stringValue(node: Node): string | null {
  if (["string", "string_literal", "raw_string_literal", "interpreted_string_literal", "quoted_attribute_value"].includes(node.type)) {
    const value = node.text;
    return value.length >= 2 ? value.slice(1, -1) : null;
  }
  for (const child of children(node)) {
    const value = stringValue(child);
    if (value) return value;
  }
  return null;
}

function docOf(node: Node, grammar: string): string | null {
  const body = node.childForFieldName("body");
  if (grammar === "python" && body) {
    const first = children(body)[0];
    const literal = first && (first.type === "expression_statement" ? children(first)[0] : first);
    if (literal && (literal.type === "string" || literal.type.includes("string"))) {
      const raw = literal.text.trim().replace(/^[ruRbB]{0,2}("""|'''|"|')/, "").replace(/("""|'''|"|')$/, "");
      return raw.trim().slice(0, 500) || null;
    }
  }
  return null;
}

function commentAbove(node: Node, parent: Node | null): string | null {
  if (!parent) return null;
  const siblings = children(parent);
  const idx = siblings.indexOf(node);
  if (idx <= 0) return null;
  const comments: Node[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const s = siblings[i];
    if (s.type === "comment") comments.unshift(s);
    else if (s.endPosition.row < node.startPosition.row - 1) break;
    else break;
  }
  if (comments.length === 0) return null;
  return comments
    .map((c) => c.text.replace(/^\s*(\/\*\*?|\/\/|#|--|;|"""|'''|\/\*|\*\/)\s?/gm, "").replace(/\*\/$/gm, "").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 500);
}

function hasJsx(node: Node): boolean {
  if (node.type.startsWith("jsx_")) return true;
  return children(node).some(hasJsx);
}

function extractImportItems(node: Node, grammar: string): ExtractedImport[] {
  const items: ExtractedImport[] = [];
  if (grammar === "typescript" || grammar === "javascript" || grammar === "tsx") {
    const sourceNode = node.childForFieldName("source") ?? children(node).find((c) => c.type.includes("string"));
    const specifier = sourceNode ? stringValue(sourceNode) : null;
    if (specifier) {
      for (const child of children(node)) {
        if (child.type === "import_clause") {
          for (const sub of children(child)) {
            if (sub.type === "identifier") {
              items.push({ localName: sub.text, importedName: "default", moduleSpecifier: specifier });
            } else if (sub.type === "named_imports") {
              for (const spec of children(sub)) {
                if (spec.type === "import_specifier") {
                  const imported = spec.childForFieldName("name")?.text ?? identifier(spec);
                  const local = spec.childForFieldName("alias")?.text ?? imported;
                  if (local && imported) {
                    items.push({ localName: local, importedName: imported, moduleSpecifier: specifier });
                  }
                }
              }
            } else if (sub.type === "namespace_import") {
              const id = children(sub).find((c) => c.type === "identifier");
              if (id) {
                items.push({ localName: id.text, importedName: "*", moduleSpecifier: specifier });
              }
            }
          }
        }
      }
    }
  } else if (grammar === "python") {
    if (node.type === "import_from_statement") {
      const modNode = node.childForFieldName("module_name");
      const modName = modNode ? modNode.text : (stringValue(node) ?? "");
      const findDotted = (n: Node) => {
        if (n === modNode) return;
        if (n.type === "aliased_import") {
          const name = n.childForFieldName("name")?.text;
          const alias = n.childForFieldName("alias")?.text ?? name;
          if (name && alias) items.push({ localName: alias, importedName: name, moduleSpecifier: modName });
          return;
        }
        if (n.type === "dotted_name" || n.type === "identifier") {
          items.push({ localName: n.text, importedName: n.text, moduleSpecifier: modName });
          return;
        }
        for (const c of children(n)) findDotted(c);
      };
      for (const c of children(node)) {
        if (c !== modNode && c.type !== "from" && c.type !== "import") findDotted(c);
      }
    } else if (node.type === "import_statement") {
      for (const child of children(node)) {
        if (child.type === "dotted_name") {
          items.push({ localName: child.text, importedName: "*", moduleSpecifier: child.text });
        } else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name")?.text;
          const alias = child.childForFieldName("alias")?.text ?? name;
          if (name && alias) {
            items.push({ localName: alias, importedName: "*", moduleSpecifier: name });
          }
        }
      }
    }
  } else if (grammar === "go") {
    const findSpecs = (n: Node): Node[] => {
      if (n.type === "import_spec") return [n];
      return children(n).flatMap(findSpecs);
    };
    for (const spec of findSpecs(node)) {
      const pathNode = spec.childForFieldName("path") ?? children(spec).find((c) => c.type.includes("string"));
      const p = pathNode ? stringValue(pathNode) : null;
      if (p) {
        const aliasNode = spec.childForFieldName("name");
        const local = aliasNode?.text || p.split("/").pop() || p;
        items.push({ localName: local, importedName: "*", moduleSpecifier: p });
      }
    }
  } else if (grammar === "rust") {
    const text = node.text.replace(/^use\s+/, "").replace(/;$/, "").trim();
    if (text) {
      const parts = text.split("::");
      const last = parts[parts.length - 1];
      if (last && !last.includes("{")) {
        const local = last.includes(" as ") ? last.split(" as ")[1].trim() : last;
        const imported = last.includes(" as ") ? last.split(" as ")[0].trim() : last;
        const mod = parts.slice(0, -1).join("::");
        items.push({ localName: local, importedName: imported, moduleSpecifier: mod || text });
      }
    }
  } else if (grammar === "java") {
    const text = node.text.replace(/^import\s+(static\s+)?/, "").replace(/;$/, "").trim();
    if (text) {
      const last = text.split(".").pop();
      if (last && last !== "*") {
        items.push({ localName: last, importedName: last, moduleSpecifier: text });
      }
    }
  } else if (grammar === "c_sharp") {
    const text = node.text.replace(/^using\s+/, "").replace(/;$/, "").trim();
    if (text) {
      if (text.includes("=")) {
        const [alias, full] = text.split("=").map((s) => s.trim());
        items.push({ localName: alias, importedName: "*", moduleSpecifier: full });
      } else {
        const last = text.split(".").pop();
        if (last) {
          items.push({ localName: last, importedName: "*", moduleSpecifier: text });
        }
      }
    }
  }
  return items;
}

export function extractSyntaxTree(relPath: string, source: string): FileExtraction {
  const grammar = grammarForPath(relPath);
  if (!grammar) return { symbols: [], relations: [] };
  return withSyntaxTree(grammar, source, (root) => {
    const symbols: FileExtraction["symbols"] = [];
    const relations: FileExtraction["relations"] = [];
    const imports: ExtractedImport[] = [];
    const emitted = new Set<string>();
    const add = (name: string, type: SymbolType, node: Node) => {
      const key = `${type}:${name}:${node.startIndex}`;
      if (emitted.has(key)) return;
      emitted.add(key);
      const doc = docOf(node, grammar) ?? commentAbove(node, node.parent) ?? undefined;
      symbols.push({ name, type, signature: textOf(node), startLine: node.startPosition.row + 1, endLine: lineEnd(node), ...(doc ? { doc } : {}) });
    };
    const relate = (from: string, to: string, rel: RelationType, confidence = 1, methodCall = false) => {
      relations.push({ from, to, rel, weight: WEIGHT[rel], confidence, ...(methodCall ? { methodCall } : {}) });
    };
    const visit = (node: Node, owner: string, enclosingClass: boolean) => {
      if (node.type === "comment" || node.type === "ERROR") return;
      let nextOwner = owner;
      let inClass = enclosingClass;
      if (CLASSES.has(node.type)) {
        const name = nameOf(node);
        if (name) {
          const type: SymbolType = node.type.includes("interface") ? "interface" : "class";
          add(name, type, node);
          nextOwner = name;
          inClass = true;
          const heritage = children(node).find((c) => c.type.includes("heritage") || c.type.includes("superclass") || c.type.includes("extends"));
          if (heritage) {
            for (const child of children(heritage)) {
              const base = identifier(child);
              if (base && base !== name) relate(name, base, "EXTENDS", 0.9);
            }
          }
        }
      } else if (FUNCTIONS.has(node.type)) {
        const name = nameOf(node);
        if (name) {
          const method = enclosingClass || node.type.includes("method") || node.type.includes("constructor");
          const component = !method && (grammar === "tsx" || grammar === "javascript") && name[0] >= "A" && name[0] <= "Z" && hasJsx(node);
          add(name, method ? "method" : component ? "component" : "function", node);
          nextOwner = name;
          inClass = false;
        }
      } else if (node.type === "variable_declarator" || node.type === "variable_declaration" && grammar === "go") {
        const name = nameOf(node);
        if (name) {
          const value = node.childForFieldName("value");
          const callable = value && ["arrow_function", "function_expression", "function", "generator_function"].includes(value.type);
          add(name, callable ? "function" : "variable", node);
          if (callable) nextOwner = name;
        }
      } else if (node.type === "type_alias_declaration" || node.type === "type_declaration") {
        const name = nameOf(node);
        if (name) add(name, "type", node);
      }

      if (IMPORTS.has(node.type)) {
        const extracted = extractImportItems(node, grammar);
        for (const item of extracted) imports.push(item);

        const target = stringValue(node) ?? node.childForFieldName("module_name")?.text ??
          (node.type === "import_statement" || node.type === "import_from_statement"
            ? children(node).map(identifier).find(Boolean) : null);
        if (target) {
          add(`import:${target}`, "import", node);
          relate("__file__", target, "IMPORTS", 0.9);
        }
      }
      if (node.type === "export_statement" || node.type === "export_declaration") {
        const target = stringValue(node);
        if (target) relate("__file__", `export*:${target}`, "EXPORTS", 0.7);
        else {
          const declaration = children(node).find((child) => CLASSES.has(child.type) || FUNCTIONS.has(child.type) || child.type.includes("declaration"));
          const name = declaration ? nameOf(declaration) : identifier(children(node).find((child) => IDENTIFIERS.has(child.type)) ?? null);
          if (name) relate("__file__", name, "EXPORTS");
        }
      }
      if (CALLS.has(node.type)) {
        const callee = node.childForFieldName("function") ?? node.childForFieldName("name") ?? children(node)[0];
        const method = !!callee && (callee.type.includes("member") || callee.type.includes("selector") || callee.type.includes("attribute") || callee.type.includes("field"));
        let target: string | null = null;
        let receiver: string | undefined = undefined;
        if (callee) {
          if (method) {
            target = identifier(callee.childForFieldName("property") ?? callee.childForFieldName("field") ?? callee.childForFieldName("attribute") ?? children(callee).at(-1) ?? null);
            const objNode = callee.childForFieldName("object") ?? callee.childForFieldName("value") ?? callee.childForFieldName("operand") ?? children(callee)[0];
            if (objNode) {
              const rName = identifier(objNode);
              if (rName) receiver = rName;
            }
          } else {
            target = identifier(callee);
          }
        }
        if (target) {
          relations.push({
            from: owner,
            to: target,
            rel: "CALLS",
            weight: WEIGHT["CALLS"],
            confidence: method ? 0.6 : 0.8,
            methodCall: method,
            ...(receiver ? { receiver } : {}),
          });
        }
      }
      if ((grammar === "html" || grammar === "vue") && node.type === "attribute") {
        const parts = children(node);
        if (parts[0]?.text === "id" && parts[1]) {
          const value = stringValue(parts[1]);
          if (value) add(value, "element", node);
        }
      }
      for (const child of children(node)) visit(child, nextOwner, inClass);
    };
    visit(root, "__file__", false);
    return { symbols, relations, ...(imports.length > 0 ? { imports } : {}) };
  });
}
