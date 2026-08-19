// @bun
// node_modules/@oxlint/plugins/index.js
function defineRule(rule) {
  return rule;
}
var EMPTY_VISITOR = {};
function eslintCompatPlugin(plugin) {
  if (typeof plugin != "object" || !plugin)
    throw Error("Plugin must be an object");
  let { rules } = plugin;
  if (typeof rules != "object" || !rules)
    throw Error("Plugin must have an object as `rules` property");
  let afterHooksState = new AfterHooksState;
  for (let ruleName in rules)
    Object.hasOwn(rules, ruleName) && convertRule(rules[ruleName], afterHooksState);
  return plugin;
}
var AfterHooksState = class {
  resetFunctions = [];
  pendingStates = [];
  pendingCount = 0;
  lintFinishedCount = 0;
  resetIsScheduled = false;
  sourceCode = null;
  resetMicrotask = this.resetMicrotaskImpl.bind(this);
  registerResetFunction(reset) {
    let { pendingStates } = this, index = pendingStates.length;
    return pendingStates.push(0), this.resetFunctions.push(reset), index;
  }
  ruleFinished() {
    this.lintFinishedCount++, this.lintFinishedCount === this.pendingCount && this.reset(false);
  }
  reset(ignoreErrors) {
    this.pendingCount;
    let { resetFunctions, pendingStates } = this, hooksLen = pendingStates.length, hasError = false, error;
    for (let i = 0;i < hooksLen; i++)
      if (pendingStates[i] !== 0) {
        pendingStates[i] = 0;
        try {
          resetFunctions[i]();
        } catch (e) {
          hasError === false && (hasError = true, error = e);
        }
      }
    if (this.pendingCount = 0, this.lintFinishedCount = 0, this.sourceCode = null, hasError === true && ignoreErrors === false)
      throw error;
  }
  scheduleReset() {
    queueMicrotask(this.resetMicrotask), this.resetIsScheduled = true;
  }
  resetMicrotaskImpl() {
    this.resetIsScheduled = false, this.pendingCount !== 0 && this.reset(true);
  }
};
function convertRule(rule, afterHooksState) {
  if (typeof rule != "object" || !rule)
    throw Error("Rule must be an object");
  if ("create" in rule)
    return;
  let context = null, visitor, beforeHook, setupAfterHook;
  rule.create = (eslintContext) => {
    context === null && ({ context, visitor, beforeHook, setupAfterHook } = createContextAndVisitor(rule, afterHooksState));
    let eslintFileContext = Object.getPrototypeOf(eslintContext);
    if (setupAfterHook !== null) {
      let { sourceCode } = eslintFileContext;
      afterHooksState.sourceCode !== sourceCode && (afterHooksState.sourceCode = sourceCode, afterHooksState.pendingCount !== 0 && afterHooksState.reset(true));
    }
    return Object.defineProperties(context, {
      id: { value: eslintContext.id },
      options: { value: eslintContext.options },
      report: { value: eslintContext.report }
    }), Object.setPrototypeOf(context, eslintFileContext), beforeHook !== null && beforeHook() === false ? EMPTY_VISITOR : (setupAfterHook !== null && (setupAfterHook(eslintFileContext.sourceCode.ast), afterHooksState.resetIsScheduled === false && afterHooksState.scheduleReset()), visitor);
  };
}
var FILE_CONTEXT = Object.freeze({
  get filename() {
    throw Error("Cannot access `context.filename` in `createOnce`");
  },
  getFilename() {
    throw Error("Cannot call `context.getFilename` in `createOnce`");
  },
  get physicalFilename() {
    throw Error("Cannot access `context.physicalFilename` in `createOnce`");
  },
  getPhysicalFilename() {
    throw Error("Cannot call `context.getPhysicalFilename` in `createOnce`");
  },
  get cwd() {
    throw Error("Cannot access `context.cwd` in `createOnce`");
  },
  getCwd() {
    throw Error("Cannot call `context.getCwd` in `createOnce`");
  },
  get sourceCode() {
    throw Error("Cannot access `context.sourceCode` in `createOnce`");
  },
  getSourceCode() {
    throw Error("Cannot call `context.getSourceCode` in `createOnce`");
  },
  get languageOptions() {
    throw Error("Cannot access `context.languageOptions` in `createOnce`");
  },
  get settings() {
    throw Error("Cannot access `context.settings` in `createOnce`");
  },
  extend(extension) {
    return Object.freeze(Object.assign(Object.create(this), extension));
  },
  get parserOptions() {
    throw Error("Cannot access `context.parserOptions` in `createOnce`");
  },
  get parserPath() {
    throw Error("Cannot access `context.parserPath` in `createOnce`");
  }
});
function createContextAndVisitor(rule, afterHooksState) {
  let { createOnce } = rule;
  if (createOnce == null)
    throw Error("Rules must define either a `create` or `createOnce` method");
  if (typeof createOnce != "function")
    throw Error("Rule `createOnce` property must be a function");
  let context = Object.create(FILE_CONTEXT, {
    id: {
      value: null,
      enumerable: true,
      configurable: true
    },
    options: {
      value: null,
      enumerable: true,
      configurable: true
    },
    report: {
      value() {
        throw Error("Cannot report errors in `createOnce`");
      },
      enumerable: true,
      configurable: true
    }
  }), { before: beforeHook, after: afterHook, ...visitor } = createOnce.call(rule, context);
  if (beforeHook === undefined)
    beforeHook = null;
  else if (beforeHook !== null && typeof beforeHook != "function")
    throw Error("`before` property of visitor must be a function if defined");
  let setupAfterHook = null;
  if (afterHook != null) {
    if (typeof afterHook != "function")
      throw Error("`after` property of visitor must be a function if defined");
    let program = null, ruleIndex = afterHooksState.registerResetFunction(() => {
      program = null, afterHook();
    });
    setupAfterHook = (ast) => {
      program = ast, afterHooksState.pendingStates[ruleIndex] = 1, afterHooksState.pendingCount++;
    };
    let onCodePathEnd = visitor.onCodePathEnd;
    visitor.onCodePathEnd = onCodePathEnd == null ? function(_codePath, node) {
      node === program && afterHooksState.ruleFinished();
    } : function(codePath, node) {
      onCodePathEnd.call(this, codePath, node), node === program && afterHooksState.ruleFinished();
    };
  }
  return {
    context,
    visitor,
    beforeHook,
    setupAfterHook
  };
}

// tools/oxlint/anti-slop/effect/rules/no-service-constructor-imports.ts
var SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
var TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
function isProjectLocalImport(source) {
  return source.startsWith("./") || source.startsWith("../");
}
function getImportedName(specifier) {
  if (specifier.imported.type === "Identifier")
    return specifier.imported.name;
  return specifier.imported.value;
}
var noServiceConstructorImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow project-local make<CapabilityName> imports outside test and spec files."
    },
    messages: {
      serviceConstructorImport: 'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.'
    }
  },
  create(context) {
    const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));
    return {
      ImportDeclaration(node) {
        if (isTestFile || !isProjectLocalImport(node.source.value))
          return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier")
            continue;
          const importedName = getImportedName(specifier);
          if (!SERVICE_CONSTRUCTOR_NAME.test(importedName))
            continue;
          context.report({
            node: specifier,
            messageId: "serviceConstructorImport",
            data: { name: importedName }
          });
        }
      }
    };
  }
});

// tools/oxlint/anti-slop/effect/index.ts
var antiSlopEffectPlugin = eslintCompatPlugin({
  meta: { name: "anti-slop-effect" },
  rules: {
    "no-service-constructor-imports": noServiceConstructorImportsRule
  }
});
var effect_default = antiSlopEffectPlugin;
export {
  effect_default as default
};
