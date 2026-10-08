// TipTap, for the transcript editor (exported on window.TipTap).
import { Editor, Node, mergeAttributes } from 'https://esm.sh/@tiptap/core@2.11.5'
      import Document from 'https://esm.sh/@tiptap/extension-document@2.11.5'
      import Paragraph from 'https://esm.sh/@tiptap/extension-paragraph@2.11.5'
      import Text from 'https://esm.sh/@tiptap/extension-text@2.11.5'
      import History from 'https://esm.sh/@tiptap/extension-history@2.11.5'
      import { Plugin, PluginKey } from 'https://esm.sh/@tiptap/pm@2.11.5/state'
      import { Decoration, DecorationSet } from 'https://esm.sh/@tiptap/pm@2.11.5/view'
      
      // Export to window for use in non-module scripts
      window.TipTap = {
        Editor,
        Node,
        mergeAttributes,
        Document,
        Paragraph,
        Text,
        History,
        Plugin,
        PluginKey,
        Decoration,
        DecorationSet
      }
      
      // Signal that TipTap is loaded
      window.dispatchEvent(new Event('tiptap-loaded'))
