; Definitions. Kind is derived from the capture name prefix.
(class_declaration name: (type_identifier) @class.name) @class.def
(abstract_class_declaration name: (type_identifier) @class.name) @class.def
(interface_declaration name: (type_identifier) @interface.name) @interface.def
(enum_declaration name: (identifier) @enum.name) @enum.def
(function_declaration name: (identifier) @function.name) @function.def
(method_definition name: (property_identifier) @method.name) @method.def
(method_signature name: (property_identifier) @method.name) @method.def
(abstract_method_signature name: (property_identifier) @method.name) @method.def
(public_field_definition name: (property_identifier) @property.name) @property.def
(type_alias_declaration name: (type_identifier) @type_alias.name) @type_alias.def
(variable_declarator name: (identifier) @variable.name) @variable.def
