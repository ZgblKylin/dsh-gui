/**
 * Markdown rendering for the quick-assistant overlay.
 *
 * A deliberately small subset: headings, paragraphs, emphasis, inline code,
 * fenced code, lists, blockquotes, rules, and http(s) links. Every piece of
 * text enters the document through `textContent`, so model output cannot inject
 * markup. Rendering is re-runnable, which is what streaming needs: each chunk
 * re-renders the accumulated text into the same container.
 */
(function () {
  'use strict'

  var CODE_FENCE = /^\s*```\s*([\w+-]*)\s*$/
  var HEADING = /^(#{1,6})\s+(.*)$/
  var RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
  var QUOTE = /^\s{0,3}>\s?(.*)$/
  var UL_ITEM = /^\s{0,3}[-*+]\s+(.*)$/
  var OL_ITEM = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/
  var INLINE_SOURCE = '(\\*\\*(?:[^*]|\\*(?!\\*))+\\*\\*|__(?:[^_]|_(?!_))+__|~~[^~]+~~|\\*[^*\\n]+\\*|_[^_\\n]+_|`[^`\\n]+`|\\[[^\\]\\n]+\\]\\((https?:\\/\\/[^\\s)]+)\\))'

  /**
   * Create one element, optionally with a class.
   * @param {string} tag - element name.
   * @param {string} [className] - class attribute.
   * @returns {HTMLElement} the element.
   */
  function element(tag, className) {
    var node = document.createElement(tag)
    if (className) node.className = className
    return node
  }

  /**
   * Render inline formatting into a fragment; newlines become line breaks.
   * @param {string} text - one line or a paragraph's joined lines.
   * @returns {DocumentFragment} the rendered nodes.
   */
  function inline(text) {
    var fragment = document.createDocumentFragment()
    var segments = String(text).split('\n')
    for (var index = 0; index < segments.length; index += 1) {
      if (index > 0) fragment.appendChild(document.createElement('br'))
      appendInlineSegment(fragment, segments[index])
    }
    return fragment
  }

  /** Append one line's inline formatting to a fragment. */
  function appendInlineSegment(fragment, line) {
    var index = 0
    var match
    // A fresh pattern per pass: an emphasis token re-enters this function, and a
    // shared global regex would have its cursor reset by the nested match.
    var pattern = new RegExp(INLINE_SOURCE, 'g')
    while ((match = pattern.exec(line)) !== null) {
      if (match.index > index) fragment.appendChild(document.createTextNode(line.slice(index, match.index)))
      fragment.appendChild(inlineToken(match[0]))
      index = match.index + match[0].length
    }
    if (index < line.length) fragment.appendChild(document.createTextNode(line.slice(index)))
  }

  /** Convert one matched inline token into an element. */
  function inlineToken(token) {
    if (token.slice(0, 2) === '**' || token.slice(0, 2) === '__') return emphasis('strong', token.slice(2, -2))
    if (token.slice(0, 2) === '~~') return emphasis('del', token.slice(2, -2))
    if (token.charAt(0) === '`') {
      var code = element('code')
      code.textContent = token.slice(1, -1)
      return code
    }
    if (token.charAt(0) === '[') {
      var link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token)
      if (link) {
        var anchor = element('a')
        anchor.href = link[2]
        anchor.target = '_blank'
        anchor.rel = 'noreferrer noopener'
        anchor.textContent = link[1]
        return anchor
      }
    }
    if (token.charAt(0) === '*' || token.charAt(0) === '_') return emphasis('em', token.slice(1, -1))
    return document.createTextNode(token)
  }

  /** Build an emphasis element around recursively rendered inline content. */
  function emphasis(tag, text) {
    var node = element(tag)
    node.appendChild(inline(text))
    return node
  }

  /** Whether a line starts a block the paragraph collector must not swallow. */
  function startsBlock(line) {
    return CODE_FENCE.test(line)
      || HEADING.test(line)
      || RULE.test(line)
      || QUOTE.test(line)
      || UL_ITEM.test(line)
      || OL_ITEM.test(line)
  }

  /** Collect the paragraph lines starting at `index`. */
  function paragraph(lines) {
    var node = element('p')
    node.appendChild(inline(lines.join('\n')))
    return node
  }

  /** Collect consecutive list items of one kind into a list element. */
  function list(lines, start) {
    var ordered = OL_ITEM.test(lines[start])
    var node = element(ordered ? 'ol' : 'ul')
    var first = ordered ? Number(OL_ITEM.exec(lines[start])[1]) : 0
    if (ordered && first > 1) node.setAttribute('start', String(first))
    var index = start
    while (index < lines.length) {
      var match = ordered ? OL_ITEM.exec(lines[index]) : UL_ITEM.exec(lines[index])
      if (!match) break
      var item = element('li')
      item.appendChild(inline(ordered ? match[2] : match[1]))
      node.appendChild(item)
      index += 1
      // A wrapped item line continues the previous item.
      while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index])) {
        item.appendChild(document.createTextNode(' '))
        item.appendChild(inline(lines[index].trim()))
        index += 1
      }
    }
    return { node: node, next: index }
  }

  /** Collect consecutive quote lines into one blockquote. */
  function quote(lines, start) {
    var parts = []
    var index = start
    while (index < lines.length) {
      var match = QUOTE.exec(lines[index])
      if (!match) break
      parts.push(match[1])
      index += 1
    }
    var node = element('blockquote')
    node.appendChild(paragraph(parts))
    return { node: node, next: index }
  }

  /**
   * Render a markdown document into a fragment.
   * @param {string} source - markdown text, possibly an incomplete stream.
   * @returns {DocumentFragment} the rendered nodes.
   */
  function render(source) {
    var root = document.createDocumentFragment()
    var lines = String(source == null ? '' : source).replace(/\r\n?/g, '\n').split('\n')
    var index = 0
    while (index < lines.length) {
      var line = lines[index]
      if (line.trim() === '') {
        index += 1
        continue
      }
      var fence = CODE_FENCE.exec(line)
      if (fence) {
        var codeLines = []
        index += 1
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          codeLines.push(lines[index])
          index += 1
        }
        if (index < lines.length) index += 1
        var pre = element('pre')
        var code = element('code', fence[1] ? 'language-' + fence[1] : '')
        code.textContent = codeLines.join('\n')
        pre.appendChild(code)
        root.appendChild(pre)
        continue
      }
      var heading = HEADING.exec(line)
      if (heading) {
        var headingNode = element('h' + heading[1].length)
        headingNode.appendChild(inline(heading[2].trim()))
        root.appendChild(headingNode)
        index += 1
        continue
      }
      if (RULE.test(line)) {
        root.appendChild(element('hr'))
        index += 1
        continue
      }
      if (QUOTE.test(line)) {
        var block = quote(lines, index)
        root.appendChild(block.node)
        index = block.next
        continue
      }
      if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
        var items = list(lines, index)
        root.appendChild(items.node)
        index = items.next
        continue
      }
      var parts = []
      while (index < lines.length && lines[index].trim() !== '' && !startsBlock(lines[index])) {
        parts.push(lines[index])
        index += 1
      }
      if (parts.length === 0) {
        // Defensive: an unclassified line must still consume input.
        index += 1
        continue
      }
      root.appendChild(paragraph(parts))
    }
    return root
  }

  /**
   * Replace a container's content with the rendered document.
   * @param {HTMLElement} container - element to fill.
   * @param {string} source - markdown text.
   */
  function renderInto(container, source) {
    container.textContent = ''
    container.appendChild(render(source))
  }

  window.qaMarkdown = { render: render, renderInto: renderInto }
})()
