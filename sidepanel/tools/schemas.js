// sidepanel/tools/schemas.js - Tool schemas declared to OpenRouter.
// Pure data: no imports, no logic.

// Tool schemas declared to OpenRouter
export const BROWSER_TOOLS = [
  {
    type: "function",
    function: {
      name: "take_snapshot",
      description: "Take a compact accessibility-style page snapshot with stable element uids for reliable interaction. Prefer this before clicking or filling elements. Use the latest snapshot because uids can become stale after page changes.",
      parameters: {
        type: "object",
        properties: {
          verbose: { type: "boolean", description: "Include more non-interactive elements. Defaults to false." },
          limit: { type: "number", description: "Maximum elements to return. Defaults to 80." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_dom",
      description: "Retrieve raw text body content and truncated HTML DOM. Use this for scraping/debugging when take_snapshot is insufficient; prefer take_snapshot for interaction.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Capture a screenshot of the visible viewport area of the current active webpage. Use this to visually see page structures, verify layout loading, or debug automation states.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "Click a page element. Prefer uid from take_snapshot. Selector is supported as a fallback. Set include_snapshot to true after actions that should change page state.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Element uid from the latest take_snapshot result." },
          selector: { type: "string", description: "Fallback CSS selector of the target element." },
          dblClick: { type: "boolean", description: "Double click the target. Defaults to false." },
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to false." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fill_element",
      description: "Set the value of an input, textarea, select, checkbox, or radio element. Prefer uid from take_snapshot; selector is a fallback.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Element uid from the latest take_snapshot result." },
          selector: { type: "string", description: "Fallback CSS selector of the target control." },
          value: { type: "string", description: "Value to enter. Use true/false for checkboxes and radio controls." },
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to false." }
        },
        required: ["value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fill_form",
      description: "Fill multiple form fields in one call. Prefer this over several fill_element calls because it is faster, more reliable, and reduces turn count.",
      parameters: {
        type: "object",
        properties: {
          elements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                uid: { type: "string", description: "Element uid from take_snapshot." },
                selector: { type: "string", description: "Fallback CSS selector." },
                value: { type: "string", description: "Value to enter." }
              },
              required: ["value"]
            }
          },
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to false." }
        },
        required: ["elements"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll_page",
      description: "Scroll the active page view up or down.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
          amount: { type: "number", description: "Pixels to scroll. Defaults to 500." }
        },
        required: ["direction"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Type text into a designated input element or the currently focused field. Prefer fill_element/fill_form for normal forms.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Optional element uid from take_snapshot." },
          selector: { type: "string", description: "Optional fallback CSS selector of the input element." },
          text: { type: "string", description: "The text value to type." },
          submitKey: { type: "string", description: "Optional key to press after typing, e.g. Enter, Tab, Escape." },
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to false." }
        },
        required: ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "hover_element",
      description: "Hover over a page element. Prefer uid from take_snapshot; selector is a fallback.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Element uid from the latest take_snapshot result." },
          selector: { type: "string", description: "Fallback CSS selector." },
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to false." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "press_key",
      description: "Press a key or key combination such as Enter, Tab, Escape, Control+A, or Control+Shift+R. Use this for keyboard shortcuts or submitting focused inputs.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key or key combination to press." },
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to false." }
        },
        required: ["key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "wait_for",
      description: "Wait for page state after navigation or interaction. Use this instead of repeatedly polling get_dom/take_snapshot.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text that should appear on the page." },
          selector: { type: "string", description: "CSS selector that should appear." },
          url_contains: { type: "string", description: "Substring expected in the current URL." },
          timeout: { type: "number", description: "Maximum wait time in milliseconds. Defaults to 8000." },
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to true on success." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_js",
      description: "Execute arbitrary Javascript expression/source in the webpage context. Prefer evaluate_script for normal scripts because it avoids top-level return syntax errors.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The Javascript snippet to evaluate on the page." }
        },
        required: ["code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_active_tab",
      description: "Get metadata about the currently active browser tab (id, url, title).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "List all tabs in the current browser window.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "Navigate the active tab to a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Destination URL." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "start_network_capture",
      description: "Start recording HTTP/network requests on the active tab. Use this when get_network_logs has no hindsight buffer yet, then reload or interact with the page.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "evaluate_script",
      description: "Evaluate a JavaScript function in the page context and return a JSON-serializable result. Example function: \"() => document.title\" or \"(selector) => document.querySelector(selector)?.innerText\".",
      parameters: {
        type: "object",
        properties: {
          function: { type: "string", description: "JavaScript function declaration/expression to execute." },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Optional string arguments passed to the function. For complex values, pass JSON strings and parse inside the function."
          }
        },
        required: ["function"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "stop_network_capture",
      description: "Stop recording network requests on the active tab.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_network_logs",
      description: "List captured network requests from the active or latched tab, including persisted session hindsight when available. Filter by URL substring, method, status code, failed state, or resource type. Set include_body to true to include redacted request/response bodies.",
      parameters: {
        type: "object",
        properties: {
          url_contains: { type: "string", description: "Filter logs to URLs containing this substring." },
          method: { type: "string", description: "Filter by HTTP method, e.g. GET or POST." },
          status: { type: "number", description: "Filter by HTTP status code, e.g. 200 or 404." },
          type: { type: "string", description: "Filter by resource type, e.g. XHR, Fetch, Document, Script." },
          failed: { type: "boolean", description: "Filter to failed requests when true, or successful/non-failed requests when false." },
          limit: { type: "number", description: "Max entries to return. Defaults to 50." },
          include_body: { type: "boolean", description: "Include redacted request/response bodies in results. Defaults to false." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_network_log_detail",
      description: "Get full details for a single network request including redacted headers and response body. Use the request id from get_network_logs.",
      parameters: {
        type: "object",
        properties: {
          request_id: { type: "string", description: "The request id from get_network_logs." }
        },
        required: ["request_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "clear_network_logs",
      description: "Clear all captured network logs for the active tab.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "get_authenticator_code",
      description: "Generate a current 6-digit TOTP authenticator code from a saved manual key for a domain. If domain is omitted, uses the active tab hostname.",
      parameters: {
        type: "object",
        properties: {
          domain: { type: "string", description: "Optional hostname or URL. Defaults to the current active tab hostname." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_authenticator_domains",
      description: "List domains that have saved authenticator manual keys. Does not reveal the keys.",
      parameters: { type: "object", properties: {} }
    }
  }
];

export const WORKSPACE_TOOLS = [
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or update a script/file in the persistent workspace. Use this for all scraper scripts, configs, and code — never dump code in chat. The user sees a compact clickable file card.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File name or path, e.g. scraper.js, utils/helpers.py" },
          content: { type: "string", description: "Full file contents." },
          language: { type: "string", description: "Optional language hint, e.g. javascript, python." },
          description: { type: "string", description: "Optional one-line summary of what the file does." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for easier recall, e.g. [\"scraper\", \"amazon\"]."
          }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the workspace by path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_context_item",
      description: "Retrieve the full original content for an archived tool result by context_item_id when a previous compact reference says more detail is available.",
      parameters: {
        type: "object",
        properties: {
          context_item_id: { type: "string", description: "The context item id shown in an archived tool result reference." }
        },
        required: ["context_item_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files in the persistent workspace with paths, languages, line counts, descriptions, and tags.",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "Optional tag filter — only list files with this tag." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search workspace files by path, description, tags, or file content. Use this to recall files when you are unsure of the exact path.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term." },
          search_in: {
            type: "string",
            enum: ["all", "path", "description", "content", "tags"],
            description: "Where to search. Defaults to all."
          },
          limit: { type: "number", description: "Max results. Defaults to 20." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_file_info",
      description: "Get metadata about a workspace file without loading full contents (path, language, line count, description, tags, last updated).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rename_file",
      description: "Rename or move a workspace file to a new path.",
      parameters: {
        type: "object",
        properties: {
          old_path: { type: "string", description: "Current file path." },
          new_path: { type: "string", description: "New file path." }
        },
        required: ["old_path", "new_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to delete." }
        },
        required: ["path"]
      }
    }
  }
];

export const WORKSPACE_TOOL_NAMES = new Set([
  "write_file", "read_file", "list_files", "search_files",
  "read_context_item", "get_file_info", "rename_file", "delete_file"
]);

export const WEB_SEARCH_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the live web using the configured search provider. Returns compact cited results with titles, URLs, snippets, scores, and optional answer text. Use this when current or external information is needed.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language search query." },
          limit: { type: "number", description: "Maximum results to return. Defaults to the configured setting." },
          topic: {
            type: "string",
            enum: ["general", "news"],
            description: "Search topic. Use news for current events; defaults to general."
          },
          search_depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description: "Provider search depth. Advanced may cost more credits."
          },
          site: { type: "string", description: "Optional domain to restrict results to, e.g. irs.gov." },
          include_answer: { type: "boolean", description: "Ask provider for a concise generated answer when supported." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_search_result",
      description: "Extract clean readable content from a specific URL returned by search_web or supplied by the user. Returns title/URL/content when available and should be used before summarizing a source in detail.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to extract." },
          extract_depth: {
            type: "string",
            enum: ["basic", "advanced"],
            description: "Extraction depth. Advanced may cost more credits."
          },
          format: {
            type: "string",
            enum: ["markdown", "text"],
            description: "Preferred content format. Defaults to markdown."
          },
          max_chars: { type: "number", description: "Maximum content characters to return. Defaults to 20000." }
        },
        required: ["url"]
      }
    }
  }
];
