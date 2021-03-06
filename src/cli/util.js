"use strict";

const path = require("path");
const camelCase = require("camelcase");
const dashify = require("dashify");
const fs = require("fs");
const globby = require("globby");
const ignore = require("ignore");
const chalk = require("chalk");
const readline = require("readline");
const leven = require("leven");

const minimist = require("./minimist");
const prettier = require("../../index");
const cleanAST = require("../common/clean-ast").cleanAST;
const errors = require("../common/errors");
const resolver = require("../config/resolve-config");
const constant = require("./constant");
const optionsModule = require("../main/options");
const optionsNormalizer = require("../main/options-normalizer");
const thirdParty = require("../common/third-party");
const getSupportInfo = require("../common/support").getSupportInfo;
const util = require("../common/util");

const OPTION_USAGE_THRESHOLD = 25;
const CHOICE_USAGE_MARGIN = 3;
const CHOICE_USAGE_INDENTATION = 2;

function getOptions(argv, detailedOptions) {
  return detailedOptions.filter(option => option.forwardToApi).reduce(
    (current, option) =>
      Object.assign(current, {
        [option.forwardToApi]: argv[option.name]
      }),
    {}
  );
}

function cliifyOptions(object, apiDetailedOptionMap) {
  return Object.keys(object || {}).reduce((output, key) => {
    const apiOption = apiDetailedOptionMap[key];
    const cliKey = apiOption ? apiOption.name : key;

    output[dashify(cliKey)] = object[key];
    return output;
  }, {});
}

function diff(a, b) {
  return require("diff").createTwoFilesPatch("", "", a, b, "", "", {
    context: 2
  });
}

function handleError(context, filename, error) {
  const isParseError = Boolean(error && error.loc);
  const isValidationError = /Validation Error/.test(error && error.message);

  // For parse errors and validation errors, we only want to show the error
  // message formatted in a nice way. `String(error)` takes care of that. Other
  // (unexpected) errors are passed as-is as a separate argument to
  // `console.error`. That includes the stack trace (if any), and shows a nice
  // `util.inspect` of throws things that aren't `Error` objects. (The Flow
  // parser has mistakenly thrown arrays sometimes.)
  if (isParseError) {
    context.logger.error(`${filename}: ${String(error)}`);
  } else if (isValidationError || error instanceof errors.ConfigError) {
    context.logger.error(String(error));
    // If validation fails for one file, it will fail for all of them.
    process.exit(1);
  } else if (error instanceof errors.DebugError) {
    context.logger.error(`${filename}: ${error.message}`);
  } else {
    context.logger.error(filename + ": " + (error.stack || error));
  }

  // Don't exit the process if one file failed
  process.exitCode = 2;
}

function logResolvedConfigPathOrDie(context, filePath) {
  const configFile = resolver.resolveConfigFile.sync(filePath);
  if (configFile) {
    context.logger.log(path.relative(process.cwd(), configFile));
  } else {
    process.exit(1);
  }
}

function writeOutput(result, options) {
  // Don't use `console.log` here since it adds an extra newline at the end.
  process.stdout.write(result.formatted);

  if (options.cursorOffset >= 0) {
    process.stderr.write(result.cursorOffset + "\n");
  }
}

function listDifferent(context, input, options, filename) {
  if (!context.argv["list-different"]) {
    return;
  }

  options = Object.assign({}, options, { filepath: filename });

  if (!prettier.check(input, options)) {
    if (!context.argv["write"]) {
      context.logger.log(filename);
    }
    process.exitCode = 1;
  }

  return true;
}

function format(context, input, opt) {
  if (context.argv["debug-print-doc"]) {
    const doc = prettier.__debug.printToDoc(input, opt);
    return { formatted: prettier.__debug.formatDoc(doc) };
  }

  if (context.argv["debug-check"]) {
    const pp = prettier.format(input, opt);
    const pppp = prettier.format(pp, opt);
    if (pp !== pppp) {
      throw new errors.DebugError(
        "prettier(input) !== prettier(prettier(input))\n" + diff(pp, pppp)
      );
    } else {
      const normalizedOpts = optionsModule.normalize(opt);
      const ast = cleanAST(
        prettier.__debug.parse(input, opt).ast,
        normalizedOpts
      );
      const past = cleanAST(
        prettier.__debug.parse(pp, opt).ast,
        normalizedOpts
      );

      if (ast !== past) {
        const MAX_AST_SIZE = 2097152; // 2MB
        const astDiff =
          ast.length > MAX_AST_SIZE || past.length > MAX_AST_SIZE
            ? "AST diff too large to render"
            : diff(ast, past);
        throw new errors.DebugError(
          "ast(input) !== ast(prettier(input))\n" +
            astDiff +
            "\n" +
            diff(input, pp)
        );
      }
    }
    return { formatted: opt.filepath || "(stdin)\n" };
  }

  return prettier.formatWithCursor(input, opt);
}

function getOptionsOrDie(context, filePath) {
  try {
    if (context.argv["config"] === false) {
      context.logger.debug(
        "'--no-config' option found, skip loading config file."
      );
      return null;
    }

    context.logger.debug(
      context.argv["config"]
        ? `load config file from '${context.argv["config"]}'`
        : `resolve config from '${filePath}'`
    );

    const options = resolver.resolveConfig.sync(filePath, {
      editorconfig: context.argv["editorconfig"],
      config: context.argv["config"]
    });

    context.logger.debug("loaded options `" + JSON.stringify(options) + "`");
    return options;
  } catch (error) {
    context.logger.error("Invalid configuration file: " + error.message);
    process.exit(2);
  }
}

function getOptionsForFile(context, filepath) {
  const options = getOptionsOrDie(context, filepath);

  const hasPlugins = options && options.plugins;
  if (hasPlugins) {
    pushContextPlugins(context, options.plugins);
  }

  const appliedOptions = Object.assign(
    { filepath },
    applyConfigPrecedence(
      context,
      options &&
        optionsNormalizer.normalizeApiOptions(options, context.supportOptions, {
          logger: context.logger
        })
    )
  );

  context.logger.debug(
    `applied config-precedence (${context.argv["config-precedence"]}): ` +
      `${JSON.stringify(appliedOptions)}`
  );

  if (hasPlugins) {
    popContextPlugins(context);
  }

  return appliedOptions;
}

function parseArgsToOptions(context, overrideDefaults) {
  const minimistOptions = createMinimistOptions(context.detailedOptions);
  const apiDetailedOptionMap = createApiDetailedOptionMap(
    context.detailedOptions
  );
  return getOptions(
    optionsNormalizer.normalizeCliOptions(
      minimist(
        context.args,
        Object.assign({
          string: minimistOptions.string,
          boolean: minimistOptions.boolean,
          default: cliifyOptions(overrideDefaults, apiDetailedOptionMap)
        })
      ),
      context.detailedOptions,
      { logger: false }
    ),
    context.detailedOptions
  );
}

function applyConfigPrecedence(context, options) {
  try {
    switch (context.argv["config-precedence"]) {
      case "cli-override":
        return parseArgsToOptions(context, options);
      case "file-override":
        return Object.assign({}, parseArgsToOptions(context), options);
      case "prefer-file":
        return options || parseArgsToOptions(context);
    }
  } catch (error) {
    context.logger.error(error.toString());
    process.exit(2);
  }
}

function formatStdin(context) {
  const filepath = context.argv["stdin-filepath"]
    ? path.resolve(process.cwd(), context.argv["stdin-filepath"])
    : process.cwd();

  const ignorer = createIgnorer(context);
  const relativeFilepath = path.relative(process.cwd(), filepath);

  thirdParty.getStream(process.stdin).then(input => {
    if (relativeFilepath && ignorer.filter([relativeFilepath]).length === 0) {
      writeOutput({ formatted: input }, {});
      return;
    }

    const options = getOptionsForFile(context, filepath);

    if (listDifferent(context, input, options, "(stdin)")) {
      return;
    }

    try {
      writeOutput(format(context, input, options), options);
    } catch (error) {
      handleError(context, "stdin", error);
    }
  });
}

function createIgnorer(context) {
  const ignoreFilePath = path.resolve(context.argv["ignore-path"]);
  let ignoreText = "";

  try {
    ignoreText = fs.readFileSync(ignoreFilePath, "utf8");
  } catch (readError) {
    if (readError.code !== "ENOENT") {
      context.logger.error(
        `Unable to read ${ignoreFilePath}: ` + readError.message
      );
      process.exit(2);
    }
  }

  return ignore().add(ignoreText);
}

function eachFilename(context, patterns, callback) {
  const ignoreNodeModules = context.argv["with-node-modules"] !== true;
  if (ignoreNodeModules) {
    patterns = patterns.concat(["!**/node_modules/**", "!./node_modules/**"]);
  }

  try {
    const filePaths = globby
      .sync(patterns, { dot: true, nodir: true })
      .map(filePath => path.relative(process.cwd(), filePath));

    if (filePaths.length === 0) {
      context.logger.error(
        `No matching files. Patterns tried: ${patterns.join(" ")}`
      );
      process.exitCode = 2;
      return;
    }
    filePaths.forEach(filePath =>
      callback(filePath, getOptionsForFile(context, filePath))
    );
  } catch (error) {
    context.logger.error(
      `Unable to expand glob patterns: ${patterns.join(" ")}\n${error.message}`
    );
    // Don't exit the process if one pattern failed
    process.exitCode = 2;
  }
}

function formatFiles(context) {
  // The ignorer will be used to filter file paths after the glob is checked,
  // before any files are actually written
  const ignorer = createIgnorer(context);

  eachFilename(context, context.filePatterns, (filename, options) => {
    const fileIgnored = ignorer.filter([filename]).length === 0;
    if (
      fileIgnored &&
      (context.argv["debug-check"] ||
        context.argv["write"] ||
        context.argv["list-different"])
    ) {
      return;
    }

    if (context.argv["write"] && process.stdout.isTTY) {
      // Don't use `console.log` here since we need to replace this line.
      context.logger.log(filename, { newline: false });
    }

    let input;
    try {
      input = fs.readFileSync(filename, "utf8");
    } catch (error) {
      // Add newline to split errors from filename line.
      context.logger.log("");

      context.logger.error(
        `Unable to read file: ${filename}\n${error.message}`
      );
      // Don't exit the process if one file failed
      process.exitCode = 2;
      return;
    }

    if (fileIgnored) {
      writeOutput({ formatted: input }, options);
      return;
    }

    listDifferent(context, input, options, filename);

    const start = Date.now();

    let result;
    let output;

    try {
      result = format(
        context,
        input,
        Object.assign({}, options, { filepath: filename })
      );
      output = result.formatted;
    } catch (error) {
      // Add newline to split errors from filename line.
      process.stdout.write("\n");

      handleError(context, filename, error);
      return;
    }

    if (context.argv["write"]) {
      if (process.stdout.isTTY) {
        // Remove previously printed filename to log it with duration.
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0, null);
      }

      // Don't write the file if it won't change in order not to invalidate
      // mtime based caches.
      if (output === input) {
        if (!context.argv["list-different"]) {
          context.logger.log(`${chalk.grey(filename)} ${Date.now() - start}ms`);
        }
      } else {
        if (context.argv["list-different"]) {
          context.logger.log(filename);
        } else {
          context.logger.log(`${filename} ${Date.now() - start}ms`);
        }

        try {
          fs.writeFileSync(filename, output, "utf8");
        } catch (error) {
          context.logger.error(
            `Unable to write file: ${filename}\n${error.message}`
          );
          // Don't exit the process if one file failed
          process.exitCode = 2;
        }
      }
    } else if (context.argv["debug-check"]) {
      if (output) {
        context.logger.log(output);
      } else {
        process.exitCode = 2;
      }
    } else if (!context.argv["list-different"]) {
      writeOutput(result, options);
    }
  });
}

function getOptionsWithOpposites(options) {
  // Add --no-foo after --foo.
  const optionsWithOpposites = options.map(option => [
    option.description ? option : null,
    option.oppositeDescription
      ? Object.assign({}, option, {
          name: `no-${option.name}`,
          type: "boolean",
          description: option.oppositeDescription
        })
      : null
  ]);
  return flattenArray(optionsWithOpposites).filter(Boolean);
}

function createUsage(context) {
  const options = getOptionsWithOpposites(context.detailedOptions).filter(
    // remove unnecessary option (e.g. `semi`, `color`, etc.), which is only used for --help <flag>
    option =>
      !(
        option.type === "boolean" &&
        option.oppositeDescription &&
        !option.name.startsWith("no-")
      )
  );

  const groupedOptions = groupBy(options, option => option.category);

  const firstCategories = constant.categoryOrder.slice(0, -1);
  const lastCategories = constant.categoryOrder.slice(-1);
  const restCategories = Object.keys(groupedOptions).filter(
    category =>
      firstCategories.indexOf(category) === -1 &&
      lastCategories.indexOf(category) === -1
  );
  const allCategories = firstCategories.concat(restCategories, lastCategories);

  const optionsUsage = allCategories.map(category => {
    const categoryOptions = groupedOptions[category]
      .map(option => createOptionUsage(context, option, OPTION_USAGE_THRESHOLD))
      .join("\n");
    return `${category} options:\n\n${indent(categoryOptions, 2)}`;
  });

  return [constant.usageSummary].concat(optionsUsage, [""]).join("\n\n");
}

function createOptionUsage(context, option, threshold) {
  const header = createOptionUsageHeader(option);
  const optionDefaultValue = getOptionDefaultValue(context, option.name);
  return createOptionUsageRow(
    header,
    `${option.description}${
      optionDefaultValue === undefined
        ? ""
        : `\nDefaults to ${createDefaultValueDisplay(optionDefaultValue)}.`
    }`,
    threshold
  );
}

function createDefaultValueDisplay(value) {
  return Array.isArray(value)
    ? `[${value.map(createDefaultValueDisplay).join(", ")}]`
    : value;
}

function createOptionUsageHeader(option) {
  const name = `--${option.name}`;
  const alias = option.alias ? `-${option.alias},` : null;
  const type = createOptionUsageType(option);
  return [alias, name, type].filter(Boolean).join(" ");
}

function createOptionUsageRow(header, content, threshold) {
  const separator =
    header.length >= threshold
      ? `\n${" ".repeat(threshold)}`
      : " ".repeat(threshold - header.length);

  const description = content.replace(/\n/g, `\n${" ".repeat(threshold)}`);

  return `${header}${separator}${description}`;
}

function createOptionUsageType(option) {
  switch (option.type) {
    case "boolean":
      return null;
    case "choice":
      return `<${option.choices
        .filter(choice => !choice.deprecated)
        .map(choice => choice.value)
        .join("|")}>`;
    default:
      return `<${option.type}>`;
  }
}

function flattenArray(array) {
  return [].concat.apply([], array);
}

function getOptionWithLevenSuggestion(context, options, optionName) {
  // support aliases
  const optionNameContainers = flattenArray(
    options.map((option, index) => [
      { value: option.name, index },
      option.alias ? { value: option.alias, index } : null
    ])
  ).filter(Boolean);

  const optionNameContainer = optionNameContainers.find(
    optionNameContainer => optionNameContainer.value === optionName
  );

  if (optionNameContainer !== undefined) {
    return options[optionNameContainer.index];
  }

  const suggestedOptionNameContainer = optionNameContainers.find(
    optionNameContainer => leven(optionNameContainer.value, optionName) < 3
  );

  if (suggestedOptionNameContainer !== undefined) {
    const suggestedOptionName = suggestedOptionNameContainer.value;
    context.logger.warn(
      `Unknown option name "${optionName}", did you mean "${suggestedOptionName}"?`
    );

    return options[suggestedOptionNameContainer.index];
  }

  context.logger.warn(`Unknown option name "${optionName}"`);
  return options.find(option => option.name === "help");
}

function createChoiceUsages(choices, margin, indentation) {
  const activeChoices = choices.filter(choice => !choice.deprecated);
  const threshold =
    activeChoices
      .map(choice => choice.value.length)
      .reduce((current, length) => Math.max(current, length), 0) + margin;
  return activeChoices.map(choice =>
    indent(
      createOptionUsageRow(choice.value, choice.description, threshold),
      indentation
    )
  );
}

function createDetailedUsage(context, optionName) {
  const option = getOptionWithLevenSuggestion(
    context,
    getOptionsWithOpposites(context.detailedOptions),
    optionName
  );

  const header = createOptionUsageHeader(option);
  const description = `\n\n${indent(option.description, 2)}`;

  const choices =
    option.type !== "choice"
      ? ""
      : `\n\nValid options:\n\n${createChoiceUsages(
          option.choices,
          CHOICE_USAGE_MARGIN,
          CHOICE_USAGE_INDENTATION
        ).join("\n")}`;

  const optionDefaultValue = getOptionDefaultValue(context, option.name);
  const defaults =
    optionDefaultValue !== undefined
      ? `\n\nDefault: ${createDefaultValueDisplay(optionDefaultValue)}`
      : "";

  const pluginDefaults =
    option.pluginDefaults && Object.keys(option.pluginDefaults).length
      ? `\nPlugin defaults:${Object.keys(option.pluginDefaults).map(
          key =>
            `\n* ${key}: ${createDefaultValueDisplay(
              option.pluginDefaults[key]
            )}`
        )}`
      : "";
  return `${header}${description}${choices}${defaults}${pluginDefaults}`;
}

function getOptionDefaultValue(context, optionName) {
  // --no-option
  if (!(optionName in context.detailedOptionMap)) {
    return undefined;
  }

  const option = context.detailedOptionMap[optionName];

  if (option.default !== undefined) {
    return option.default;
  }

  const optionCamelName = camelCase(optionName);
  if (optionCamelName in context.apiDefaultOptions) {
    return context.apiDefaultOptions[optionCamelName];
  }

  return undefined;
}

function indent(str, spaces) {
  return str.replace(/^/gm, " ".repeat(spaces));
}

function groupBy(array, getKey) {
  return array.reduce((obj, item) => {
    const key = getKey(item);
    const previousItems = key in obj ? obj[key] : [];
    return Object.assign({}, obj, { [key]: previousItems.concat(item) });
  }, Object.create(null));
}

function pick(object, keys) {
  return !keys
    ? object
    : keys.reduce(
        (reduced, key) => Object.assign(reduced, { [key]: object[key] }),
        {}
      );
}

function createLogger(logLevel) {
  return {
    warn: createLogFunc("warn", "yellow"),
    error: createLogFunc("error", "red"),
    debug: createLogFunc("debug", "blue"),
    log: createLogFunc("log")
  };

  function createLogFunc(loggerName, color) {
    if (!shouldLog(loggerName)) {
      return () => {};
    }

    const prefix = color ? `[${chalk[color](loggerName)}] ` : "";
    return function(message, opts) {
      opts = Object.assign({ newline: true }, opts);
      const stream = process[loggerName === "log" ? "stdout" : "stderr"];
      stream.write(message.replace(/^/gm, prefix) + (opts.newline ? "\n" : ""));
    };
  }

  function shouldLog(loggerName) {
    switch (logLevel) {
      case "silent":
        return false;
      default:
        return true;
      case "debug":
        if (loggerName === "debug") {
          return true;
        }
      // fall through
      case "log":
        if (loggerName === "log") {
          return true;
        }
      // fall through
      case "warn":
        if (loggerName === "warn") {
          return true;
        }
      // fall through
      case "error":
        return loggerName === "error";
    }
  }
}

function normalizeDetailedOption(name, option) {
  return Object.assign({ category: constant.CATEGORY_OTHER }, option, {
    choices:
      option.choices &&
      option.choices.map(choice => {
        const newChoice = Object.assign(
          { description: "", deprecated: false },
          typeof choice === "object" ? choice : { value: choice }
        );
        if (newChoice.value === true) {
          newChoice.value = ""; // backward compability for original boolean option
        }
        return newChoice;
      })
  });
}

function normalizeDetailedOptionMap(detailedOptionMap) {
  return Object.keys(detailedOptionMap)
    .sort()
    .reduce((normalized, name) => {
      const option = detailedOptionMap[name];
      return Object.assign(normalized, {
        [name]: normalizeDetailedOption(name, option)
      });
    }, {});
}

function createMinimistOptions(detailedOptions) {
  return {
    boolean: detailedOptions
      .filter(option => option.type === "boolean")
      .map(option => option.name),
    string: detailedOptions
      .filter(option => option.type !== "boolean")
      .map(option => option.name),
    default: detailedOptions
      .filter(option => !option.deprecated)
      .filter(option => !option.forwardToApi || option.name === "plugin")
      .filter(option => option.default !== undefined)
      .reduce(
        (current, option) =>
          Object.assign({ [option.name]: option.default }, current),
        {}
      ),
    alias: detailedOptions
      .filter(option => option.alias !== undefined)
      .reduce(
        (current, option) =>
          Object.assign({ [option.name]: option.alias }, current),
        {}
      )
  };
}

function createApiDetailedOptionMap(detailedOptions) {
  return detailedOptions.reduce(
    (current, option) =>
      option.forwardToApi && option.forwardToApi !== option.name
        ? Object.assign(current, { [option.forwardToApi]: option })
        : current,
    {}
  );
}

function createDetailedOptionMap(supportOptions) {
  return supportOptions.reduce((reduced, option) => {
    const newOption = Object.assign({}, option, {
      name: option.cliName || dashify(option.name),
      description: option.cliDescription || option.description,
      category: option.cliCategory || constant.CATEGORY_FORMAT,
      forwardToApi: option.name
    });

    if (option.deprecated) {
      delete newOption.forwardToApi;
      delete newOption.description;
      delete newOption.oppositeDescription;
      newOption.deprecated = true;
    }

    return Object.assign(reduced, { [newOption.name]: newOption });
  }, {});
}

//-----------------------------context-util-start-------------------------------
/**
 * @typedef {Object} Context
 * @property logger
 * @property args
 * @property argv
 * @property filePatterns
 * @property supportOptions
 * @property detailedOptions
 * @property detailedOptionMap
 * @property apiDefaultOptions
 */
function createContext(args) {
  const context = { args };

  updateContextArgv(context);
  normalizeContextArgv(context, ["loglevel", "plugin"]);

  context.logger = createLogger(context.argv["loglevel"]);

  updateContextArgv(context, context.argv["plugin"]);

  return context;
}

function initContext(context) {
  // split into 2 step so that we could wrap this in a `try..catch` in cli/index.js
  normalizeContextArgv(context);
}

function updateContextOptions(context, plugins) {
  const supportOptions = getSupportInfo(null, {
    showDeprecated: true,
    showUnreleased: true,
    showInternal: true,
    plugins
  }).options;

  const detailedOptionMap = normalizeDetailedOptionMap(
    Object.assign({}, createDetailedOptionMap(supportOptions), constant.options)
  );

  const detailedOptions = util.arrayify(detailedOptionMap, "name");

  const apiDefaultOptions = supportOptions
    .filter(optionInfo => !optionInfo.deprecated)
    .reduce(
      (reduced, optionInfo) =>
        Object.assign(reduced, { [optionInfo.name]: optionInfo.default }),
      Object.assign({}, optionsModule.hiddenDefaults)
    );

  context.supportOptions = supportOptions;
  context.detailedOptions = detailedOptions;
  context.detailedOptionMap = detailedOptionMap;
  context.apiDefaultOptions = apiDefaultOptions;
}

function pushContextPlugins(context, plugins) {
  context._supportOptions = context.supportOptions;
  context._detailedOptions = context.detailedOptions;
  context._detailedOptionMap = context.detailedOptionMap;
  context._apiDefaultOptions = context.apiDefaultOptions;
  updateContextOptions(context, plugins);
}

function popContextPlugins(context) {
  context.supportOptions = context._supportOptions;
  context.detailedOptions = context._detailedOptions;
  context.detailedOptionMap = context._detailedOptionMap;
  context.apiDefaultOptions = context._apiDefaultOptions;
}

function updateContextArgv(context, plugins) {
  pushContextPlugins(context, plugins);

  const minimistOptions = createMinimistOptions(context.detailedOptions);
  const argv = minimist(context.args, minimistOptions);

  context.argv = argv;
  context.filePatterns = argv["_"];
}

function normalizeContextArgv(context, keys) {
  const detailedOptions = !keys
    ? context.detailedOptions
    : context.detailedOptions.filter(
        option => keys.indexOf(option.name) !== -1
      );
  const argv = !keys ? context.argv : pick(context.argv, keys);

  context.argv = optionsNormalizer.normalizeCliOptions(argv, detailedOptions, {
    logger: context.logger
  });
}
//------------------------------context-util-end--------------------------------

module.exports = {
  createContext,
  createDetailedOptionMap,
  createDetailedUsage,
  createUsage,
  format,
  formatFiles,
  formatStdin,
  initContext,
  logResolvedConfigPathOrDie,
  normalizeDetailedOptionMap
};
