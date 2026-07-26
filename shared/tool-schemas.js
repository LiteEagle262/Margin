// Tool definitions shared by the in-chat agent (which needs OpenAI function
// shape) and the MCP bridge (which needs MCP shape). Adding a tool here is the
// only edit required: the extension pushes the MCP-shaped list to the bridge
// server at connect time, so the server carries no copy of its own.

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
      name: "browser_batch",
      description: "Run several browser actions in one tool call instead of one call per action. Use this whenever the next two or more steps are already known — navigate then wait_for then take_snapshot, or fill a form then click submit. Actions run in order and stop at the first failure unless stop_on_error is false. Batchable: navigate, open_tab, select_tab, click_element, fill_element, fill_form, type_text, hover_element, press_key, scroll_page, wait_for, take_snapshot, get_dom, get_active_tab, list_tabs, run_js, evaluate_script. take_screenshot, close_tab, workspace, search, and MCP tools must be called on their own.",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            description: "Ordered actions to run, at most 10.",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", description: "Name of the browser tool to run." },
                arguments: { type: "object", description: "Arguments for that tool, exactly as its own schema defines them." }
              },
              required: ["tool"]
            }
          },
          stop_on_error: { type: "boolean", description: "Stop after the first failed action and mark the rest skipped. Defaults to true." },
          include_snapshot: { type: "boolean", description: "Append one page snapshot after the last action. Defaults to false." }
        },
        required: ["actions"]
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
      description: "Click a page element. Prefer uid from take_snapshot. Selector is supported as a fallback. Set include_snapshot to true after actions that should change page state. The result reports effect {url_changed, dom_mutations} observed ~250ms after the click; a zero effect means the click may not have done anything — re-snapshot before assuming success.",
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
          include_snapshot: { type: "boolean", description: "Include a fresh snapshot in the result. Defaults to false; set true to opt in." }
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
      name: "open_tab",
      description: "Open a new browser tab at a URL and return its tab id. Use this for a fresh page alongside the current one; use navigate to reuse the current tab.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Destination http(s) URL." },
          background: { type: "boolean", description: "Open the tab without switching to it. Defaults to false." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "select_tab",
      description: "Activate a tab by id to change which tab subsequent browser tools act on. Ids come from list_tabs. If the user has latched a tab, tools keep targeting the latched tab until the user unlatches it.",
      parameters: {
        type: "object",
        properties: {
          tab_id: { type: "number", description: "Tab id from list_tabs or open_tab." }
        },
        required: ["tab_id"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_tab",
      description: "Close a tab by id. Ids come from list_tabs. The tab the user has latched cannot be closed.",
      parameters: {
        type: "object",
        properties: {
          tab_id: { type: "number", description: "Tab id from list_tabs or open_tab." }
        },
        required: ["tab_id"]
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
      description: "List captured network requests from the active or latched tab, including persisted session hindsight when available. WebSocket and EventSource (SSE) connections are included with a frameCount; use type \"WebSocket\" or \"EventSource\" to filter for them. Filter by URL substring, method, status code, failed state, or resource type. Set include_body to true to include redacted request/response bodies.",
      parameters: {
        type: "object",
        properties: {
          url_contains: { type: "string", description: "Filter logs to URLs containing this substring." },
          method: { type: "string", description: "Filter by HTTP method, e.g. GET or POST." },
          status: { type: "number", description: "Filter by HTTP status code, e.g. 200 or 404." },
          type: { type: "string", description: "Filter by resource type, e.g. XHR, Fetch, Document, Script." },
          failed: { type: "boolean", description: "Filter to failed requests when true, or successful/non-failed requests when false." },
          limit: { type: "number", description: "Max entries to return after filters search the full buffer. Defaults to 50, capped at 150." },
          include_body: { type: "boolean", description: "Include redacted request/response bodies in results. Defaults to false." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_network_log_detail",
      description: "Get full details for a single network request including redacted headers and response body. For WebSocket/EventSource connections this also returns the captured frames (most recent first capped). Use the request id from get_network_logs.",
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
      description: "Generate a current 6-digit TOTP authenticator code from the saved manual key for the active tab's hostname and return it as text, for cases where the code must go somewhere other than the current page. For entering the code into the page, prefer fill_secret. Codes for other sites cannot be generated; navigate the tab there first.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "fill_secret",
      description: "Fill the current TOTP authenticator code for the active tab's saved domain directly into a page element — the code is never shown to the model. Prefer this over get_authenticator_code whenever the goal is entering the code into the page.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Element uid of the code input from the latest take_snapshot result." }
        },
        required: ["uid"]
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

export const WORKSPACE_TOOL_NAMES = new Set(WORKSPACE_TOOLS.map((tool) => tool.function.name));

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

// Recon tools can expose session secrets and remain a separate, opt-in access group.
export const RECON_TOOLS = [
  {
    type: "function",
    function: {
      name: "http_request",
      description: "Make an HTTP request from the active page's context so its cookies, session, and origin apply. Use this to replay or modify an API call seen in network logs — change params/headers/body and inspect the response — instead of writing fetch code with run_js. Returns status, headers, and body. Cross-origin requests are still subject to the page's CORS policy.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Request URL. Relative URLs resolve against the active page." },
          method: { type: "string", description: "HTTP method. Defaults to GET." },
          headers: { type: "object", description: "Optional request headers as a key/value object." },
          body: { type: "string", description: "Optional request body string (e.g. JSON or form-encoded). Omit for GET/HEAD." },
          credentials: { type: "string", enum: ["include", "omit", "same-origin"], description: "Whether to send cookies. Defaults to include." },
          max_response_chars: { type: "number", description: "Maximum response body characters to return. Defaults to 20000." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_cookies",
      description: "Read cookies for the active tab's site, including httpOnly cookies that page scripts cannot access. Use this to understand session and auth tokens when reverse-engineering an API. Cookies of other sites cannot be read; navigate the tab there first.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional cookie name filter." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_storage",
      description: "Read localStorage and/or sessionStorage for the active page. Useful for finding auth tokens, CSRF tokens, feature flags, and app state.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["local", "session", "all"], description: "Which storage to read. Defaults to all." },
          keys: { type: "array", items: { type: "string" }, description: "Optional list of keys to return. Omit for all keys." }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_scripts",
      description: "List JavaScript files loaded by the active page (external src, inline, and resource-timing entries). Use before search_scripts to see the available bundles.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "search_scripts",
      description: "Search the source of the page's loaded JavaScript bundles for a string or regex. Use this to find API endpoints, GraphQL operations, keys, or feature flags baked into the code. Returns matching snippets with file and line, not whole bundles. Cross-origin scripts are fetched only when their CORS policy allows it.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term or regex source." },
          regex: { type: "boolean", description: "Treat query as a case-insensitive regular expression. Defaults to false (substring)." },
          max_matches: { type: "number", description: "Maximum matches to return. Defaults to 30, capped at 200." }
        },
        required: ["query"]
      }
    }
  }
];

// Tools the MCP bridge proxies back into the extension. Workspace tools are
// left out because MCP clients have their own filesystem access, and web-search
// tools are left out because the bridge server gates those on their own feature
// flag and owns their definitions.
export const MCP_PROXIED_TOOLS = [...BROWSER_TOOLS, ...RECON_TOOLS];

export function toMcpToolSchema(tool) {
  const definition = tool.function || {};
  return {
    name: definition.name,
    description: definition.description || "",
    inputSchema: definition.parameters || { type: "object", properties: {} }
  };
}
