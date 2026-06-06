const path = require('path');

exports.createPages = async ({ graphql, actions }) => {
  const { createPage } = actions;

  const result = await graphql(`
    query {
      markdownRemark {
        html
        tableOfContents(maxDepth: 3)
        headings(depth: h2) {
          value
        }
      }
    }
  `);

  if (result.errors) {
    throw result.errors;
  }

  createPage({
    path: '/',
    component: path.resolve('./src/templates/doc-template.js'),
    context: {
      html: result.data.markdownRemark.html,
      toc: result.data.markdownRemark.tableOfContents,
    },
  });
};
