; Definitions. Kind is derived from the capture name prefix.
(class_definition name: (identifier) @class.name) @class.def
(function_definition name: (identifier) @function.name) @function.def
(expression_statement
  (assignment left: (identifier) @variable.name)) @variable.def
