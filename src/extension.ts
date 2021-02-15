import { languages, workspace, Range, Position, CompletionItem, CompletionItemKind, Hover, ColorPresentation, ColorInformation, Color } from 'vscode';
import { generate } from './core';
import { highlightCSS, isColor, hex2RGB } from './utils';
import { fileTypes } from './filetypes';
import { ClassParser } from 'windicss/utils/parser';
import type { Generator } from './interfaces';
import type { ExtensionContext, Disposable } from 'vscode';

let GENERATOR:Generator = {colors:{}, variants: {}, staticUtilities: {}, dynamicUtilities: {}};
const TRIGGERS = ['"', "'", ' ', ':'];

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export async function activate(context: ExtensionContext) {
  // Generate utilities&variants and set them on activation
  GENERATOR = await generate();
  const fileSystemWatcher = workspace.createFileSystemWatcher('**/{tailwind,windi}.config.js');

  // Changes configuration should invalidate above cache
  fileSystemWatcher.onDidChange(async () => {
    GENERATOR = await generate();
  });

  // This handles the case where the project didn't have config file
  // but was created after VS Code was initialized
  fileSystemWatcher.onDidCreate(async () => {
    GENERATOR = await generate();
  });

  // If the config is deleted, utilities&variants should be regenerated
  fileSystemWatcher.onDidDelete(async () => {
    GENERATOR = await generate();
  });

  let disposables: Disposable[] = [];
  for (const { extension, patterns } of fileTypes) {
    patterns.forEach(pattern => {
      // class completion
      disposables = disposables.concat(languages.registerCompletionItemProvider(extension, {
        provideCompletionItems: (document, position) => {
          // Get range including all characters in the current line till the current position
          const range = new Range(new Position(position.line, 0), position);
          // Get text in current line
          const textInCurrentLine = document.getText(range);
          const classesInCurrentLine = textInCurrentLine
            .match(pattern.regex)?.[1]
            .split(pattern.splitCharacter) ?? [];

          const staticCompletion = Object.keys(GENERATOR.staticUtilities).filter(i => !classesInCurrentLine.includes(i)).map(classItem => {
            const item = new CompletionItem(classItem, CompletionItemKind.Constant);
            item.documentation = highlightCSS(GENERATOR.processor?.interpret(classItem).styleSheet.build());
            return item;
          });

          const variantsCompletion = Object.keys(GENERATOR.variants).map(variant => {
            const item = new CompletionItem(variant + ':', CompletionItemKind.Module);
            const style = GENERATOR.variants[variant]();
            style.selector = '&';
            item.documentation = highlightCSS(style.build().replace(`{\n  & {}\n}`, '{\n  ...\n}').replace('{}', '{\n  ...\n}'));
            // trigger suggestion after select variant
            item.command = {
              command: 'editor.action.triggerSuggest',
              title: variant
            };
            return item;
          });

          // Object.keys(GENERATOR.dynamicUtilities).filter()

          // handle dynamic utilities
          const dynamic = ['p-${size}', 'p-${int}', 'bg-${color}'];

          const dynamicCompletion = dynamic.filter(i => !i.endsWith('${color}')).map(utility => {
            const item = new CompletionItem(utility, CompletionItemKind.Variable);
            // item.documentation = highlightCSS(GENERATOR.processor?.interpret())
            const start = utility.search(/\$/);
            item.command = {
              command: 'cursorMove',
              arguments: [{
                to: "left",
                select: true,
                value: start === -1 ? 0 : utility.length - start,
              }],
              title: utility
            };
            return item;
          });

          const colorsCompletion: CompletionItem[] = [];
          dynamic.filter(i => i.endsWith('${color}')).map(utility => {
            const head = utility.replace('${color}', '');
            for (const [key, value] of Object.entries(GENERATOR.colors)) {
              const color = new CompletionItem(head + key, CompletionItemKind.Color);
              color.detail = GENERATOR.processor?.interpret(head + key).styleSheet.build();
              color.documentation = ['transparent', 'currentColor'].includes(value)? value: `rgb(${hex2RGB(value)?.join(', ')})`;
              colorsCompletion.push(color);
            }
          });

          return [...variantsCompletion, ...staticCompletion, ...colorsCompletion, ...dynamicCompletion];
        },
      
      }, ...TRIGGERS)).concat(languages.registerHoverProvider(extension, {
        // hover class show css preview
        provideHover: (document, position, token) => {
          const word = document.getText(document.getWordRangeAtPosition(position, /[\w-:+.@/]+/));
          const style = GENERATOR.processor?.interpret(word);
          if (style && style.ignored.length === 0) { return new Hover(highlightCSS(style.styleSheet.build()) ?? ''); }
        }
      })).concat(languages.registerColorProvider(extension, {
        // insert color before class
        provideDocumentColors: (document, token) => {
          const colors: ColorInformation[] = [];
          for (const line of Array.from(Array(document.lineCount).keys())) {
            const text = document.lineAt(line).text;
            if (text.match(/class=["|']([.\w-+@: ]*)/)) {
              const matched = text.match(/(?<=class=["|'])[^"']*/);
              if (matched && matched.index) {
                const offset = matched.index; 
                const elements = new ClassParser(matched[0]).parse();
                elements.forEach(element => {
                  if (typeof element.content === 'string') {
                    const color = isColor(element.raw, GENERATOR.colors);
                    if (color) {
                      const char = element.start + offset;
                      colors.push(new ColorInformation(new Range(new Position(line, char), new Position(line, char + 1)), new Color(color[0]/255, color[1]/255, color[2]/255, 1)));
                    }
                  }
                });
              }
            };
          }
          return colors;
        },
        provideColorPresentations: (color, context, token) => {
          return [];
        }
      }));
    });
  };
  context.subscriptions.push(...disposables);
  console.log('"windicss-intellisense" is now active!');
}

// this method is called when your extension is deactivated
export function deactivate() {}
